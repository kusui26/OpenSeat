/**
 * 指標の収集（全体プラン 8.3）。
 *
 * シミュレータが残した素の観測（イベントの列と席の区間）から、方針を比べるのに
 * 要る数字を作る。**ここは走らせない。** 1 回ぶんの結果を受け取って数えるだけの
 * 純粋な関数群にしてあるので、手で組み立てた小さな筋書きでも検算できる。
 *
 * ## 測れないもの
 *
 * 8.3 は「放置・期限切れ・キャンセルの率」を求めているが、**このシミュレータでは
 * 放置と自発的なキャンセルが構造的に 0 になる。** 利用者の模型が `CANCEL` も
 * 心拍も出さないためで、率を出しても「0 が出た」以上のことは言えない。
 * 8.1 に率が無いものを勝手に決めないという判断（`agent.ts`）の裏返しである。
 * 終わり方の内訳（`endings`）は 10 通りすべて出すので、**どれが 0 なのかが
 * 数字として見える**ようにしてある。
 *
 * 8.3 の「スタッフの介入回数」も、スタッフが操作を出さないので直接は測れない。
 * 代わりに**確認要がどう解けたか**を出す（`recovery`）。自動解放で解けた回数が、
 * 自動解放を切っている施設でスタッフが出向く回数にあたる。
 *
 * ## 時間の単位
 *
 * 外に出す数字は**分**で、小数第 1 位まで丸める。内部の計算はミリ秒のまま行う。
 */

import type {
  DomainEvent,
  DurationMs,
  EndReason,
  Table,
  TableStatus,
  Timestamp,
} from '../src/index.js';
import { MINUTE_MS, TABLE_STATUSES } from '../src/index.js';
import type { BaselineResult, Search } from './baseline.js';
import type { RunResult, TableSpan, WaitSample } from './runner.js';
import { SIM_EPOCH } from './runner.js';

// ---- 分布 ----

/**
 * ヒストグラムの階級。**5 分刻み**で、最後の階級だけが開いている。
 *
 * 刻みを `eta_bucket_min` の既定（5 分）に合わせてある。画面に出す幅と同じ
 * 刻みで分布を見られるようにするためである。
 */
export const HISTOGRAM_STEP_MIN = 5;

/** 階級の数。0〜5 分から 85〜90 分まで、最後が「90 分以上」。 */
export const HISTOGRAM_BUCKETS = 19;

/** ひと揃いの待ち時間をまとめたもの。単位は分。 */
export interface Distribution {
  readonly count: number;
  readonly meanMin: number;
  readonly p50Min: number;
  readonly p90Min: number;
  readonly maxMin: number;
  /**
   * 5 分刻みの度数（`HISTOGRAM_BUCKETS` 個）。
   *
   * **平均と p90 だけでは分布の形が見えない。** 「ほとんどが 10 分で、一部が
   * 90 分」と「全員が 30 分前後」は同じ平均になりうるが、利用者にとっては
   * まったく別のことである。CSV には出さず、HTML レポートが使う。
   */
  readonly histogram: readonly number[];
}

const EMPTY_DISTRIBUTION: Distribution = {
  count: 0,
  meanMin: 0,
  p50Min: 0,
  p90Min: 0,
  maxMin: 0,
  histogram: Array.from({ length: HISTOGRAM_BUCKETS }, () => 0),
};

/**
 * 分布をまとめる。
 *
 * **1 件も無ければ 0 を返す。** 「測れなかった」ことは `count` が語るので、
 * 欠測を表す特別な値を作らない（CSV に入れたときに平均が壊れる）。
 */
export function summarize(samples: readonly DurationMs[]): Distribution {
  if (samples.length === 0) return EMPTY_DISTRIBUTION;
  const sorted: readonly DurationMs[] = samples.toSorted((a, b) => a - b);
  const total: DurationMs = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    meanMin: toMin(total / sorted.length),
    p50Min: toMin(percentile(sorted, 0.5)),
    p90Min: toMin(percentile(sorted, 0.9)),
    maxMin: toMin(percentile(sorted, 1)),
    histogram: histogramOf(sorted),
  };
}

/** 5 分刻みに数える。上限を超えたものは最後の階級に入れる。 */
function histogramOf(samples: readonly DurationMs[]): readonly number[] {
  const counts: number[] = Array.from({ length: HISTOGRAM_BUCKETS }, () => 0);
  for (const sample of samples) {
    const bucket: number = Math.floor(sample / MINUTE_MS / HISTOGRAM_STEP_MIN);
    const index: number = Math.min(Math.max(bucket, 0), HISTOGRAM_BUCKETS - 1);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}

/**
 * 最近傍順位のパーセンタイル。**「これ以下に `fraction` が入る」いちばん小さい値。**
 *
 * 補間しないのは、待ち時間が「実際に誰かが待った長さ」だからである。3 人が
 * 5・10・30 分待ったなら p90 は 30 分で、存在しない 26 分ではない。
 */
function percentile(sorted: readonly DurationMs[], fraction: number): DurationMs {
  const rank: number = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] ?? 0;
}

/** ミリ秒を分に。小数第 1 位まで。 */
function toMin(ms: number): number {
  return Math.round((ms / MINUTE_MS) * 10) / 10;
}

/** 割合。分母が 0 なら 0。 */
function share(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 1000;
}

// ---- 指標 ----

/** 対象区画に来た組と、その行き先。 */
export interface Demand {
  /** 並ぶつもりで来た組。**飛び込みと無断利用は含まない。** */
  readonly arrived: number;
  /** 目安を見て登録をやめた組（7.5 の 5）。 */
  readonly balked: number;
  /** 受付を断られた組（待ち行列の上限、受付終了後）。 */
  readonly refused: number;
  /** 受付した組。 */
  readonly joined: number;
  /** 座席 QR から直接座った組（7.12）。 */
  readonly walkIns: number;
  /** 受付して席に着いた組。 */
  readonly seated: number;
  /** 受付したが席に着かずに終わった組。 */
  readonly leftWithoutSeat: number;
}

/** 人数ごとの待ち時間。**2 名組と 4 名組の差を見るためにある**（8.3）。 */
export interface SizeSlice {
  readonly partySize: number;
  /** その人数だった組の数。 */
  readonly parties: number;
  /** 席へ向かえるまでの時間。自由席のベースラインでは探索時間にあたる。 */
  readonly wait: Distribution;
}

/** 席がどう使われたか。割合は運用していた席時間に対するもの。 */
export interface SeatUse {
  /** 運用していた席時間（卓 × 分）。 */
  readonly managedTableMin: number;
  /** 人が座っていた割合。**これが稼働率**（8.3）。 */
  readonly occupiedShare: number;
  /** 確保したまま誰も座っていなかった割合（8.3「ホールドで遊んだ時間」）。 */
  readonly heldShare: number;
  /** 片付けの猶予で空けていた割合。 */
  readonly turnoverShare: number;
  /** 確認要のまま塞がっていた割合。 */
  readonly needsCheckShare: number;
  /** 無断利用として塞がっていた割合。 */
  readonly unknownShare: number;
  /** 空席だった割合。 */
  readonly freeShare: number;
  /**
   * 使われていた卓について、座っていた人数 ÷ その卓の定員。
   *
   * **7.6 の「ロスを最小にする」がどれだけ効いたか**を、稼働率と切り離して見る。
   * 4 人席に 2 人が座っているあいだは 0.5 になる。**稼働率を掛けていない**ので、
   * 空いている時間が長い施設でも下がらない（混ぜると 2 つの別々のことが
   * 1 つの数字に潰れて、どちらが動いたのか読めなくなる）。
   */
  readonly fillShare: number;
  /** ノーショーで確保したまま遊ばせた席時間（分）。8.3 の「失われた席時間」。 */
  readonly noShowLostMin: number;
}

/** 現実とのずれが表に出た回数。 */
export interface Incidents {
  readonly calls: number;
  /**
   * **席を確保して呼んだのに、着いたら誰かが座っていた回数**（7.8 の 10 行目）。
   *
   * 渡すと約束した席を渡せなかった、という事故である。8.3 が「事故の件数と率」と
   * 呼んでいるのはこれ。
   */
  readonly seatTaken: number;
  readonly seatTakenRate: number;
  /**
   * 「空いている可能性が高い席」を見に行ったら使用中だった回数（7.11 の 3 層目）。
   *
   * **事故ではない。** 確証が無いと断ったうえで確かめに行ってもらった結果で、
   * 仕組みが働いている証拠である。歩かせた手間は掛かるので別に数える。
   *
   * **同じ `TableReportedInUse` から出るので、分けずに数えると `assign_needs_check`
   * を切ったときに「事故が減った」と読めてしまう**（実測で 5.5% → 1.6%。
   * 減ったのは事故ではなく、確かめに行く回数だった）。
   */
  readonly probedInUse: number;
  /** 呼ばれたのに来なかった回数。 */
  readonly noShows: number;
  readonly noShowRate: number;
}

/**
 * 確認要になった席が、どう解けたか（7.10、7.11）。
 *
 * | 次の姿 | 何が起きたか |
 * |---|---|
 * | `OCCUPIED` | 案内された人が前倒しで座った、または本人が「まだ利用中」と答えた |
 * | `OCCUPIED_UNKNOWN` | 見に行った人が「使用中でした」と報告した |
 * | `TURNOVER` | 本人が退席を申告した |
 * | `FREE` | 自動解放、またはスタッフが「空席にする」を押した |
 * | `DISABLED` | 運用が終わった |
 *
 * **`FREE` の回数が、自動解放を切っている施設でスタッフが出向く回数にあたる**
 * （8.3 の「スタッフの介入回数」の代わり。このシミュレータはスタッフ操作を
 * 出さないので、直接は測れない）。
 */
export interface Recovery {
  readonly needsCheck: number;
  readonly byOverstay: number;
  readonly byNoAnswer: number;
  readonly byUnknownAged: number;
  readonly clearedTo: Readonly<Record<TableStatus, number>>;
  /** 確認要のまま塞がっていた時間の合計（分）。 */
  readonly needsCheckMin: number;
}

/**
 * 順番がどれだけ守られたか。
 *
 * **8.3 には無いが、8.2 の 1 項目目（厳密 FIFO と本方式の比較）がこれを要る。**
 * 「なぜ後から来た 4 人組が先に案内されたのか」（7.1）が実際に何回起きたかを
 * 数えないと、公平性の繰り上げ（7.6）を評価できない。
 */
export interface Fairness {
  /** 自分より後に受付した組に、先を越された回数の平均。 */
  readonly overtakenMean: number;
  readonly overtakenMax: number;
  /** 一度でも先を越された組の割合。 */
  readonly overtakenShare: number;
}

/** 目安（7.13）が実際とどれだけ違ったか。 */
export interface EtaError {
  /** 予測と実績が揃った件数。 */
  readonly samples: number;
  /**
   * 目安を出したが、呼び出しに至らなかった件数。
   *
   * **この数を必ず併記する。** 誤差は「呼ばれた人」だけで測っているので、
   * 呼ばれなかった人が多いほど、誤差は実際より小さく見える。
   */
  readonly unmatched: number;
  /** 平均絶対誤差（分）。 */
  readonly maeMin: number;
  /** 偏り（予測 − 実績、分）。正なら長めに出している。 */
  readonly biasMin: number;
  /** 実績が、画面に出した幅の中に入った割合。 */
  readonly inBucketShare: number;
}

/** 1 回の実行から取れる指標のすべて。 */
export interface Metrics {
  readonly scenario: string;
  readonly seed: number;
  readonly tables: number;
  readonly seats: number;
  readonly demand: Demand;
  /** 受付から最初の呼び出しまで。**画面の目安（7.13）が予測しているのはこれ。** */
  readonly wait: Distribution;
  /** 受付から着席まで。**自由席の探索時間と比べるのはこれ。** */
  readonly toSeat: Distribution;
  readonly bySize: readonly SizeSlice[];
  readonly seatUse: SeatUse;
  readonly incidents: Incidents;
  readonly recovery: Recovery;
  readonly endings: Readonly<Record<EndReason, number>>;
  readonly fairness: Fairness;
  readonly eta: EtaError;
}

// ---- イベントの取り出し ----

/** その種別のイベントだけを、型を保ったまま取り出す。 */
function eventsOf<T extends DomainEvent['type']>(
  events: readonly DomainEvent[],
  type: T,
): readonly Extract<DomainEvent, { readonly type: T }>[] {
  return events.filter((event): event is Extract<DomainEvent, { readonly type: T }> => event.type === type);
}

/** チケットごとに、いちばん早い時刻を覚える。2 度目以降は無視する。 */
function firstAt(entries: readonly { readonly ticketId: string; readonly at: Timestamp }[]): ReadonlyMap<string, Timestamp> {
  const found = new Map<string, Timestamp>();
  for (const entry of entries) {
    if (!found.has(entry.ticketId)) found.set(entry.ticketId, entry.at);
  }
  return found;
}

// ---- 組み立て ----

/** 1 回の実行から指標を取る。 */
export function collect(result: RunResult): Metrics {
  const joins = eventsOf(result.events, 'TicketJoined');
  const queued = joins.filter((event) => event.origin === 'JOIN');
  const calledAt = firstAt(eventsOf(result.events, 'TicketCalled'));
  const seatedAt = firstAt(eventsOf(result.events, 'TicketSeated'));

  return {
    ...venueOf(result),
    demand: demandOf(result, queued.length, joins.length - queued.length, seatedAt),
    wait: summarize(elapsed(queued, calledAt)),
    toSeat: summarize(elapsed(queued, seatedAt)),
    bySize: slicesBySize(queued, calledAt),
    seatUse: seatUseOf(result),
    incidents: incidentsOf(result),
    recovery: recoveryOf(result),
    endings: endingsOf(result.events),
    fairness: overtaking(reachedPairs(queued, calledAt)),
    eta: etaErrorOf(result, calledAt),
  };
}

/** どの実行で、どんな施設だったか。 */
function venueOf(result: RunResult): Pick<Metrics, 'scenario' | 'seed' | 'tables' | 'seats'> {
  return {
    scenario: result.scenario,
    seed: result.seed,
    tables: result.state.tables.length,
    seats: result.state.tables.reduce((sum, table) => sum + table.capacity, 0),
  };
}

/** 受付から、その出来事までの時間。起きなかった人は数えない。 */
function elapsed(
  joins: readonly { readonly ticketId: string; readonly at: Timestamp }[],
  reached: ReadonlyMap<string, Timestamp>,
): readonly DurationMs[] {
  return joins.flatMap((join) => {
    const at: Timestamp | undefined = reached.get(join.ticketId);
    return at === undefined ? [] : [at - join.at];
  });
}

function demandOf(
  result: RunResult,
  joined: number,
  walkIns: number,
  seatedAt: ReadonlyMap<string, Timestamp>,
): Demand {
  const seated: number = eventsOf(result.events, 'TicketJoined').filter(
    (event) => event.origin === 'JOIN' && seatedAt.has(event.ticketId),
  ).length;
  return {
    arrived: result.parties.length,
    balked: result.balked.length,
    refused: result.parties.length - result.balked.length - joined,
    joined,
    walkIns,
    seated,
    leftWithoutSeat: joined - seated,
  };
}

/** 人数ごとの待ち時間。**1〜6 名をすべて出す**（0 件でも行を残す）。 */
function slicesBySize(
  joins: readonly { readonly ticketId: string; readonly at: Timestamp; readonly partySize: number }[],
  calledAt: ReadonlyMap<string, Timestamp>,
): readonly SizeSlice[] {
  return PARTY_SIZES_REPORTED.map((partySize) => {
    const mine = joins.filter((join) => join.partySize === partySize);
    return { partySize, parties: mine.length, wait: summarize(elapsed(mine, calledAt)) };
  });
}

/**
 * 人数別に出す区切り。
 *
 * 8.1 の人数分布が 1〜6 名なので、そこに合わせてある。7 名以上の組は
 * `bySize` に現れないが、全体の `wait` には入っている。
 */
export const PARTY_SIZES_REPORTED: readonly number[] = [1, 2, 3, 4, 5, 6];

// ---- 席の使われ方 ----

function seatUseOf(result: RunResult): SeatUse {
  const byStatus = minutesByStatus(result.tableSpans);
  const managed: number = TABLE_STATUSES.filter((status) => status !== 'DISABLED').reduce(
    (sum, status) => sum + (byStatus.get(status) ?? 0),
    0,
  );
  return {
    managedTableMin: toMin(managed),
    occupiedShare: share(byStatus.get('OCCUPIED') ?? 0, managed),
    heldShare: share(byStatus.get('HELD') ?? 0, managed),
    turnoverShare: share(byStatus.get('TURNOVER') ?? 0, managed),
    needsCheckShare: share(byStatus.get('NEEDS_CHECK') ?? 0, managed),
    unknownShare: share(byStatus.get('OCCUPIED_UNKNOWN') ?? 0, managed),
    freeShare: share(byStatus.get('FREE') ?? 0, managed),
    fillShare: fillShareOf(result),
    noShowLostMin: toMin(noShowLostOf(result)),
  };
}

function minutesByStatus(spans: readonly TableSpan[]): ReadonlyMap<TableStatus, DurationMs> {
  const totals = new Map<TableStatus, DurationMs>();
  for (const span of spans) {
    totals.set(span.status, (totals.get(span.status) ?? 0) + (span.until - span.from));
  }
  return totals;
}

/**
 * 使われていた卓について、座っていた人数 ÷ その卓の定員。
 *
 * 分母も分子も**使われていた区間だけ**を見る。空いている時間は両方から外れる
 * ので、稼働率とは独立に動く。
 *
 * **無断利用の人数は数えられない。** システムから見えないので、その卓は分母
 * からも外す（`OCCUPIED` の区間だけを見ているので、自然にそうなる）。
 */
function fillShareOf(result: RunResult): number {
  const sizes = partySizes(result.events);
  const capacities = capacityById(result.state.tables);
  const occupied = result.tableSpans.filter((span) => span.status === 'OCCUPIED');
  const seatedSum: number = occupied.reduce(
    (sum, span) => sum + (sizes.get(span.occupantTicketId ?? '') ?? 0) * (span.until - span.from),
    0,
  );
  const capacitySum: number = occupied.reduce(
    (sum, span) => sum + (capacities.get(span.tableId) ?? 0) * (span.until - span.from),
    0,
  );
  return share(seatedSum, capacitySum);
}

function partySizes(events: readonly DomainEvent[]): ReadonlyMap<string, number> {
  return new Map(eventsOf(events, 'TicketJoined').map((event) => [event.ticketId, event.partySize]));
}

function capacityById(tables: readonly Table[]): ReadonlyMap<string, number> {
  return new Map(tables.map((table) => [table.id, table.capacity]));
}

/**
 * ノーショーで確保したまま遊ばせた席時間。
 *
 * 確保していた区間のうち、**そのあいだにその人のノーショーが記録された**ものを
 * 合計する。数えるのは確保の始まりからノーショーまでで、その先は次の人のもの
 * である。
 *
 * **区間の終わりとノーショーの時刻は一致しない。** 期限はその期限の時刻で
 * 処理される（PR 6）が、空いた席が同じ刻みのうちに次の人へ確保されると、
 * 区間の切れ目はその確保の時刻（刻みの時刻）になる。時刻の一致で探していた
 * ときは、7 件のうち 5 件を取りこぼしていた。
 */
function noShowLostOf(result: RunResult): DurationMs {
  const missed: ReadonlyMap<string, readonly Timestamp[]> = noShowTimes(result.events);
  return result.tableSpans
    .filter((span) => span.status === 'HELD')
    .flatMap((span) => {
      const at: Timestamp | undefined = (missed.get(span.occupantTicketId ?? '') ?? []).find(
        (time) => span.from <= time && time <= span.until,
      );
      return at === undefined ? [] : [at - span.from];
    })
    .reduce((sum, wasted) => sum + wasted, 0);
}

/**
 * 呼ばれたのに来なかった時刻を、人ごとに並べる。
 *
 * **3 つの経路をすべて数える。** ノーショーの扱いは方針で変わり、出るイベントも
 * 変わる。`requeue_once` は保留へ（`TicketPaused`）、`requeue_back` は待ちの
 * 末尾へ（`TicketRequeued`）、`cancel` はそこで終わる（`TicketEnded`）。
 * **1 つだけを数えると方針の比較が壊れる**（`requeue_back` のノーショーが
 * 1 件も無いように見え、ノーショーで遊ばせた席時間が 0 分と出ていた）。
 */
function noShowTimes(events: readonly DomainEvent[]): ReadonlyMap<string, readonly Timestamp[]> {
  const times = new Map<string, readonly Timestamp[]>();
  const missed = [
    ...eventsOf(events, 'TicketPaused').filter((event) => event.reason === 'no_show'),
    ...eventsOf(events, 'TicketRequeued').filter((event) => event.reason === 'no_show'),
    ...eventsOf(events, 'TicketEnded').filter((event) => event.endReason === 'no_show'),
  ];
  for (const event of missed) {
    times.set(event.ticketId, [...(times.get(event.ticketId) ?? []), event.at]);
  }
  return times;
}

// ---- 事故と回復 ----

/**
 * 事故と、確かめに行った結果を分ける。
 *
 * どちらも `TableReportedInUse` として出るので、**その直前に席がどの姿だった
 * かで見分ける。** 確保していた席（`HELD`）なら事故、確認要の席なら空振りである。
 */
function incidentsOf(result: RunResult): Incidents {
  const calls: number = eventsOf(result.events, 'TicketCalled').length;
  const before: readonly (TableStatus | null)[] = eventsOf(result.events, 'TableReportedInUse')
    .filter((event) => event.reportedByTicketId !== null)
    .map((event) => statusBefore(result.tableSpans, event.tableId, event.at));
  const seatTaken: number = before.filter((status) => status === 'HELD').length;
  const noShows: number = countOf(noShowTimes(result.events));
  return {
    calls,
    seatTaken,
    seatTakenRate: share(seatTaken, calls),
    probedInUse: before.filter((status) => status === 'NEEDS_CHECK').length,
    noShows,
    noShowRate: share(noShows, calls),
  };
}

function countOf(times: ReadonlyMap<string, readonly Timestamp[]>): number {
  return [...times.values()].reduce((sum, list) => sum + list.length, 0);
}

/** その時刻の直前に、席がどの姿だったか。区間が無ければ `null`。 */
function statusBefore(
  spans: readonly TableSpan[],
  tableId: string,
  at: Timestamp,
): TableStatus | null {
  const earlier = spans
    .filter((span) => span.tableId === tableId && span.until <= at)
    .toSorted((a, b) => (a.until === b.until ? a.from - b.from : a.until - b.until));
  return earlier.at(-1)?.status ?? null;
}

function recoveryOf(result: RunResult): Recovery {
  const marked = eventsOf(result.events, 'TableNeedsCheck');
  const spans = result.tableSpans.filter((span) => span.status === 'NEEDS_CHECK');
  return {
    needsCheck: marked.length,
    byOverstay: marked.filter((event) => event.reason === 'overstay').length,
    byNoAnswer: marked.filter((event) => event.reason === 'no_answer').length,
    byUnknownAged: marked.filter((event) => event.reason === 'unknown_aged').length,
    clearedTo: clearedToOf(result.tableSpans),
    needsCheckMin: toMin(spans.reduce((sum, span) => sum + (span.until - span.from), 0)),
  };
}

/**
 * 確認要の次にどの姿になったかを数える。最後まで確認要だったものは数えない。
 *
 * **総当たりの表にしてある**ので、席の状態を足したらここも埋めなければ
 * 型が通らない（`src/eta.ts` と同じ形）。
 */
function clearedToOf(spans: readonly TableSpan[]): Readonly<Record<TableStatus, number>> {
  const after: readonly TableStatus[] = statusesAfterNeedsCheck(spans);
  const count = (status: TableStatus): number =>
    after.filter((seen) => seen === status).length;
  return {
    DISABLED: count('DISABLED'),
    FREE: count('FREE'),
    HELD: count('HELD'),
    OCCUPIED: count('OCCUPIED'),
    OCCUPIED_UNKNOWN: count('OCCUPIED_UNKNOWN'),
    TURNOVER: count('TURNOVER'),
    NEEDS_CHECK: count('NEEDS_CHECK'),
  };
}

/** 確認要だった区間の、次の区間の状態を並べる。 */
function statusesAfterNeedsCheck(spans: readonly TableSpan[]): readonly TableStatus[] {
  const tables: readonly string[] = [...new Set(spans.map((span) => span.tableId))];
  return tables.flatMap((tableId) => {
    const mine = spans.filter((span) => span.tableId === tableId);
    return mine.flatMap((span, index) =>
      span.status === 'NEEDS_CHECK' && mine[index + 1] !== undefined
        ? [mine[index + 1]?.status ?? 'NEEDS_CHECK']
        : [],
    );
  });
}

// ---- 終わり方 ----

/**
 * 終わり方 10 通りの内訳。**起きなかったものも 0 として残す。**
 *
 * `user_cancel`・`staff_cancel`・`abandoned` は、このシミュレータでは必ず 0 に
 * なる（利用者の模型が `CANCEL` も心拍も出さない）。**0 を隠さずに出すことで、
 * 「測っていない」ことが読む側に伝わる。**
 */
function endingsOf(events: readonly DomainEvent[]): Readonly<Record<EndReason, number>> {
  const ended = eventsOf(events, 'TicketEnded');
  const count = (reason: EndReason): number =>
    ended.filter((event) => event.endReason === reason).length;
  return {
    checked_out: count('checked_out'),
    staff_checkout: count('staff_checkout'),
    auto_release: count('auto_release'),
    user_cancel: count('user_cancel'),
    staff_cancel: count('staff_cancel'),
    venue_closed: count('venue_closed'),
    no_show: count('no_show'),
    abandoned: count('abandoned'),
    pause_expired: count('pause_expired'),
    max_age: count('max_age'),
  };
}

// ---- 公平性 ----

/** 並び始めた時刻と、席へ向かえるようになった時刻の組。 */
interface Reached {
  readonly at: Timestamp;
  readonly reachedAt: Timestamp;
}

/**
 * 先を越された回数を数える。
 *
 * 並び始めた順に並べ、**自分より後から来たのに先に席へ向かえた組**を数える。
 * 席に届かなかった組は「越した側」にも「越された側」にもならない。
 *
 * **自由席のベースラインも同じ関数で数える。** 向こうには順番という仕掛けが
 * 無いので、ここが両者のいちばん分かりやすい違いになる。
 */
export function overtaking(reached: readonly Reached[]): Fairness {
  const ordered: readonly Reached[] = reached.toSorted((a, b) => a.at - b.at);
  const counts: readonly number[] = ordered.map(
    (mine, index) =>
      ordered.slice(index + 1).filter((later) => later.reachedAt < mine.reachedAt).length,
  );
  return {
    overtakenMean: counts.length === 0 ? 0 : Math.round((sum(counts) / counts.length) * 100) / 100,
    overtakenMax: counts.reduce((most, value) => Math.max(most, value), 0),
    overtakenShare: share(counts.filter((value) => value > 0).length, counts.length),
  };
}

/** 受付した組のうち、呼び出しまで届いたものを組にする。 */
function reachedPairs(
  joins: readonly { readonly ticketId: string; readonly at: Timestamp }[],
  calledAt: ReadonlyMap<string, Timestamp>,
): readonly Reached[] {
  return joins.flatMap((join) => {
    const at: Timestamp | undefined = calledAt.get(join.ticketId);
    return at === undefined ? [] : [{ at: join.at, reachedAt: at }];
  });
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

// ---- 目安の誤差 ----

function etaErrorOf(result: RunResult, calledAt: ReadonlyMap<string, Timestamp>): EtaError {
  const bucket: number = result.state.policy.etaBucketMin;
  const pairs = result.estimates.flatMap((sample) => matched(sample, calledAt));
  const errors: readonly number[] = pairs.map((pair) => pair.predictedMin - pair.actualMin);
  const inBucket: number = pairs.filter(
    (pair) => within(pair.actualMin, pair.predictedMin, bucket),
  ).length;
  return {
    samples: pairs.length,
    unmatched: result.estimates.length - pairs.length,
    maeMin: pairs.length === 0 ? 0 : round1(sum(errors.map(Math.abs)) / pairs.length),
    biasMin: pairs.length === 0 ? 0 : round1(sum(errors) / pairs.length),
    inBucketShare: share(inBucket, pairs.length),
  };
}

/** 目安と、その人が実際に呼ばれるまでの時間。呼ばれなかった人は落ちる。 */
function matched(
  sample: WaitSample,
  calledAt: ReadonlyMap<string, Timestamp>,
): readonly { readonly predictedMin: number; readonly actualMin: number }[] {
  const at: Timestamp | undefined = calledAt.get(sample.ticketId);
  if (at === undefined) return [];
  return [{ predictedMin: sample.minutes, actualMin: (at - sample.at) / MINUTE_MS }];
}

/** 実績が、画面に出した幅（7.13 の `eta_display`）の中に入ったか。 */
function within(actualMin: number, predictedMin: number, bucketMin: number): boolean {
  const fromMin: number = Math.floor(predictedMin / bucketMin) * bucketMin;
  return actualMin >= fromMin && actualMin <= fromMin + bucketMin;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ---- 自由席のベースライン ----

/**
 * 自由席の指標（8.3 の「自由席ベースラインとの比較」）。
 *
 * **`search` は座れた組だけの分布である。** 座れなかった組を外して平均を取ると
 * 実態より短く見えるので、`stillSearching` を必ず並べて読むこと。
 */
export interface BaselineMetrics {
  readonly scenario: string;
  readonly seed: number;
  readonly arrived: number;
  readonly seated: number;
  /** 卓を見つけたのに、そこまで待ったせいで受け取らなかった組。 */
  readonly gaveUp: number;
  /** 見届ける時刻まで探し続けていた組。 */
  readonly stillSearching: number;
  /** 到着から着席まで、歩き回った時間。 */
  readonly search: Distribution;
  readonly bySize: readonly SizeSlice[];
  readonly occupiedShare: number;
  readonly fillShare: number;
  readonly fairness: Fairness;
}

export function collectBaseline(result: BaselineResult): BaselineMetrics {
  const seated = result.searches.filter((search) => search.seatedAt !== null);
  return {
    scenario: result.scenario,
    seed: result.seed,
    arrived: result.searches.length,
    seated: seated.length,
    gaveUp: result.searches.filter((search) => search.gaveUpAt !== null).length,
    stillSearching: result.searches.filter(
      (search) => search.seatedAt === null && search.gaveUpAt === null,
    ).length,
    search: summarize(searchTimes(result.searches)),
    bySize: PARTY_SIZES_REPORTED.map((partySize) => sliceOf(result.searches, partySize)),
    occupiedShare: share(result.occupiedMs, result.tableMs),
    fillShare: share(result.seatedPersonMs, result.occupiedCapacityMs),
    fairness: overtaking(
      seated.map((search) => ({ at: search.arriveAt, reachedAt: search.seatedAt ?? search.arriveAt })),
    ),
  };
}

function sliceOf(searches: readonly Search[], partySize: number): SizeSlice {
  const mine = searches.filter((search) => search.partySize === partySize);
  return { partySize, parties: mine.length, wait: summarize(searchTimes(mine)) };
}

/** 到着から着席までの時間。座れなかった組は落ちる。 */
function searchTimes(searches: readonly Search[]): readonly DurationMs[] {
  return searches.flatMap((search) =>
    search.seatedAt === null ? [] : [search.seatedAt - search.arriveAt],
  );
}

// ---- 検算 ----

/**
 * 席の区間が、開始から見届けた時刻までを隙間なく覆っているか。
 *
 * **覆えていなければ稼働率が静かに小さく出る。** 観測の取りこぼしは数字を
 * 壊すだけで例外を出さないので、CLI はここを見て止まる。
 */
export function spanCoverage(result: RunResult): {
  readonly expectedMin: number;
  readonly observedMin: number;
} {
  const window: DurationMs = result.endedAt - SIM_EPOCH;
  const observed: DurationMs = result.tableSpans.reduce(
    (total, span) => total + (span.until - span.from),
    0,
  );
  return {
    expectedMin: toMin(window * result.state.tables.length),
    observedMin: toMin(observed),
  };
}
