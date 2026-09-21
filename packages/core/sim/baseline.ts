/**
 * 自由席のベースライン（全体プラン 8.1 の最終行）。
 *
 * **比較の相手がいないと「良くなった」と言えない。** OpenSeat を入れない
 * フードコートで、同じ人たちが同じ時刻に来たら何が起きるかを出す。
 *
 * ## 探すという行為の模型
 *
 * 自由席の客は施設の全体を見渡せない。**歩きながら、1 卓ずつ覗いていく。**
 * 空いていて自分たちが収まる卓に行き当たったら座る。これだけで、8.1 が書いた
 * 「占有率 95% 超で探索 5〜15 分、席取り失敗で再探索」が自然に出る。卓が 30 あって
 * 空きが 1.5 なら 1 回の覗きで当たる見込みは 5% で、30 秒に 1 卓のペースなら
 * 10 分ほどかかる。
 *
 * **1 回で当たる見込みは「空いている卓 ÷ 全部の卓」＝ 1 − 占有率**で、卓数が
 * 約分されて消える。混み具合が同じならフロアの広さによらず同じ時間がかかる、
 * ということである。**この性質があるから、8.1 の校正（広いフロアで測った
 * 5〜15 分）を 26 席の実証区画にそのまま当てはめられる。** 逆に「広いフロアほど
 * 歩く距離が延びる」ことは入れていない。入れるなら観察で測ってからにする。
 *
 * **席取り失敗も、別の規則を足さずに出る。** 同じ刻みに同じ卓を覗いた 2 組の
 * うち、座れるのは先に見た 1 組だけで、もう 1 組は探索を続ける。
 *
 * ## OpenSeat と同じにしてあるところ
 *
 * **諦める人は、両方に同じだけいる。** 8.1 のノーショー率（基礎 8%、待ち
 * 20 分超で 15%）は「そこまで待った組が、もう席を受け取らない確率」である。
 * OpenSeat では呼び出しの時点で効き、自由席では卓を見つけた時点で効く。
 * **同じ組の同じ目を使う**ので、諦めるかどうかは両方でそろう。
 *
 * これを入れないと比較が成り立たない。OpenSeat の側には人が抜ける道が 2 つ
 * （目安を見てやめる、呼ばれても来ない）あり、自由席の側に 1 つも無いと、
 * 「座れた組」の差がほとんど抜け道の有無で決まってしまう。
 *
 * ## OpenSeat と違うところ（意図して違えてある）
 *
 * - **収まる卓なら、どれでも座る。** 1 名が 6 名席に座る。自由席には「ロスを
 *   最小にする」規則が無い（7.6）ので、これを入れたら比較にならない
 * - **順番が無い。** 先に来た人が先に座れる保証が無く、後から来た人が目の前の
 *   卓に座ってしまう。`metrics.ts` の「先を越された回数」がこれを数える
 * - **並ぶ前に引き返す人がいない。** 自由席は待ち時間を教えてくれないので、
 *   探し始める前にやめる判断ができない（7.5 の 5 は OpenSeat が足すもの）。
 *   **これは模型の手抜きではなく、自由席にその情報が無いという事実である**
 * - **片付けの猶予が無い。** 立った瞬間に次の人が座れる。**自由席に有利な側に
 *   倒してある**（実際には片付いていない卓を避ける時間がかかる）
 * - **無断利用が無い。** 自由席では全員が「無断」なので、区別そのものが無い。
 *   そのぶん自由席の側は負荷が軽く見積もられており、**比較は OpenSeat に
 *   不利な側に倒れている**
 *
 * ## 校正されていないこと
 *
 * `SCAN_RATE_PER_MIN` は 8.1 に無い。**現地観察（Phase 0、17.4 の観察シート）で
 * 「見つけるまでの時間」を測って置き換える**ことが 8.1 の最終行の指示である。
 * それまでは、この模型が出す絶対値を施設に示さないこと（8.5）。
 */

import type { DurationMs, Timestamp } from '../src/index.js';
import { minutes } from '../src/index.js';
import type { Party } from './agent.js';
import { decidesNoShow } from './agent.js';
import type { Rng } from './rng.js';
import { streamFor } from './rng.js';
import { plannedParties, SIM_EPOCH } from './runner.js';
import type { Scenario } from './scenario.js';

/**
 * 1 分間に見て回れる卓数。**8.1 に無い。現地観察で置き換える。**
 *
 * 30 秒に 1 卓。混んだフードコートを歩きながら「あの卓は空いているか、
 * 荷物が置いてあるだけか」を確かめる速さとして置いた。
 */
export const SCAN_RATE_PER_MIN = 2;

export interface BaselineOptions {
  readonly scenario: Scenario;
  readonly seed: number;
  /** 受付を閉じたあと、どれだけ見届けるか。`run` と同じ既定にする。 */
  readonly cooldown?: DurationMs;
  readonly scanRatePerMin?: number;
}

/** 1 組が席を探した結果。 */
export interface Search {
  readonly ticketId: string;
  readonly partySize: number;
  readonly arriveAt: Timestamp;
  /** 座れた時刻。座らずに終わったなら `null`。 */
  readonly seatedAt: Timestamp | null;
  /**
   * 探すのをやめた時刻。
   *
   * **卓を見つけたのに、そこまで待ったせいで受け取らなかった**組である
   * （OpenSeat のノーショーと同じ判定）。最後まで探していた組は `null`。
   */
  readonly gaveUpAt: Timestamp | null;
}

export interface BaselineResult {
  readonly scenario: string;
  readonly seed: number;
  readonly scanRatePerMin: number;
  readonly searches: readonly Search[];
  /** 卓が使われていた時間の合計。 */
  readonly occupiedMs: DurationMs;
  /** 座っていた人数 × その時間の合計。 */
  readonly seatedPersonMs: number;
  /** 使われていた卓の定員 × その時間の合計。`seatedPersonMs` の分母になる。 */
  readonly occupiedCapacityMs: number;
  /** 卓 × 見届けた時間。 */
  readonly tableMs: DurationMs;
  readonly endedAt: Timestamp;
}

/** 席に着いている組。 */
interface Occupant {
  readonly partySize: number;
  readonly since: Timestamp;
  readonly until: Timestamp;
}

/** まだ席を探している組と、その組だけの乱数の流れ。 */
interface Searcher {
  readonly party: Party;
  readonly rng: Rng;
}

/** その刻みに、誰がどの卓を覗くか。 */
interface Probe {
  readonly searcher: Searcher;
  readonly tableIndex: number;
  /** 同じ卓を覗いた組の順番を決める目。偏らないように、覗く先と同じ目から作る。 */
  readonly roll: number;
}

/**
 * 到着を順に取り出す。
 *
 * **到着順に並んでいることを前提にしている**（`arrivalTimes` は間引き法で
 * 時刻を増やしながら並べるので、必ず昇順になる）。
 */
class Arrivals {
  private next = 0;

  constructor(
    private readonly parties: readonly Party[],
    private readonly seed: number,
  ) {}

  /** その時刻までに着いた組を、席を探す側の形で返す。取り出した分は消える。 */
  take(now: Timestamp): readonly Searcher[] {
    const found: Searcher[] = [];
    while (this.next < this.parties.length) {
      const party: Party | undefined = this.parties[this.next];
      if (party === undefined || party.arriveAt > now) break;
      found.push({ party, rng: streamFor(this.seed, 'search', party.index) });
      this.next += 1;
    }
    return found;
  }
}

// ---- フロア ----

/** 卓の並び。座る・立つ・使われた時間を数えることだけを受け持つ。 */
class Floor {
  private readonly occupants: (Occupant | null)[];
  private occupiedMs = 0;
  private seatedPersonMs = 0;
  private occupiedCapacityMs = 0;

  constructor(private readonly capacities: readonly number[]) {
    this.occupants = capacities.map(() => null);
  }

  /** 滞在が終わった組を立たせる。 */
  release(now: Timestamp): void {
    this.occupants.forEach((occupant, index) => {
      if (occupant !== null && occupant.until <= now) this.clear(index, occupant, occupant.until);
    });
  }

  /** その卓が空いていて、その人数が収まるか。**収まりさえすれば座る。** */
  accepts(index: number, partySize: number): boolean {
    return this.occupants[index] === null && partySize <= (this.capacities[index] ?? 0);
  }

  sit(index: number, partySize: number, at: Timestamp, until: Timestamp): void {
    this.occupants[index] = { partySize, since: at, until };
  }

  /** 見届ける時刻になった。まだ座っている組を、その時刻で打ち切る。 */
  finish(endedAt: Timestamp): void {
    this.occupants.forEach((occupant, index) => {
      if (occupant !== null) this.clear(index, occupant, endedAt);
    });
  }

  get tables(): number {
    return this.capacities.length;
  }

  get used(): {
    readonly occupiedMs: DurationMs;
    readonly seatedPersonMs: number;
    readonly occupiedCapacityMs: number;
  } {
    return {
      occupiedMs: this.occupiedMs,
      seatedPersonMs: this.seatedPersonMs,
      occupiedCapacityMs: this.occupiedCapacityMs,
    };
  }

  private clear(index: number, occupant: Occupant, at: Timestamp): void {
    const stayed: DurationMs = Math.max(at - occupant.since, 0);
    this.occupiedMs += stayed;
    this.seatedPersonMs += stayed * occupant.partySize;
    this.occupiedCapacityMs += stayed * (this.capacities[index] ?? 0);
    this.occupants[index] = null;
  }
}

// ---- 走らせる ----

/**
 * 自由席のフードコートを 1 回走らせる。
 *
 * **来る人は OpenSeat の側とまったく同じ**（`plannedParties` を共有している）。
 * 同じシードなら、同じ組が同じ時刻に、同じ人数で、同じ滞在時間だけ座る。
 * 差として出るのは「席の決まり方」だけになる。
 */
export function runBaseline(options: BaselineOptions): BaselineResult {
  const { scenario, seed } = options;
  const endsAt: Timestamp = SIM_EPOCH + scenario.joinOpenFor + (options.cooldown ?? minutes(60));
  const scanRatePerMin: number = options.scanRatePerMin ?? SCAN_RATE_PER_MIN;
  const step: DurationMs = Math.max(Math.round(minutes(1) / scanRatePerMin), 1);

  const parties: readonly Party[] = plannedParties(scenario, seed);
  const floor = new Floor(capacitiesOf(scenario));
  const arrivals = new Arrivals(parties, seed);
  const ended = new Outcomes();
  let searching: readonly Searcher[] = [];

  for (let now: Timestamp = SIM_EPOCH; now <= endsAt; now += step) {
    floor.release(now);
    searching = sweep([...searching, ...arrivals.take(now)], { floor, ended, scenario }, now);
  }
  floor.finish(endsAt);
  return report({ scenario, seed, scanRatePerMin, parties, ended, floor, endedAt: endsAt });
}

/** 探し終えた組の行き先。座れたか、諦めたか。 */
class Outcomes {
  private readonly seatedAt = new Map<string, Timestamp>();
  private readonly gaveUpAt = new Map<string, Timestamp>();

  sat(ticketId: string, at: Timestamp): void {
    this.seatedAt.set(ticketId, at);
  }

  gaveUp(ticketId: string, at: Timestamp): void {
    this.gaveUpAt.set(ticketId, at);
  }

  /** もう探していない組か。 */
  done(ticketId: string): boolean {
    return this.seatedAt.has(ticketId) || this.gaveUpAt.has(ticketId);
  }

  of(ticketId: string): Pick<Search, 'seatedAt' | 'gaveUpAt'> {
    return {
      seatedAt: this.seatedAt.get(ticketId) ?? null,
      gaveUpAt: this.gaveUpAt.get(ticketId) ?? null,
    };
  }
}

/** 卓ごとの定員を並べる。 */
function capacitiesOf(scenario: Scenario): readonly number[] {
  return scenario.tables.flatMap((spec) => Array.from({ length: spec.count }, () => spec.capacity));
}

/** 1 刻みぶん進めるのに要るもの。 */
interface Sweeping {
  readonly floor: Floor;
  readonly ended: Outcomes;
  readonly scenario: Scenario;
}

/**
 * 探している組が、それぞれ 1 卓ずつ覗く。決着した組は探索から外れる。
 *
 * **覗く順は目の小さい順**にしてある。同じ卓を狙った組のあいだでは、その目が
 * そのまま順番になるので、早く来たほうが有利にならない（自由席には順番が無い）。
 *
 * **卓が見つかっても、そこまで待った組は受け取らないことがある。** OpenSeat の
 * ノーショーと同じ目・同じ率で決める（8.1）。その卓は次の組に回る。
 */
function sweep(
  searching: readonly Searcher[],
  world: Sweeping,
  now: Timestamp,
): readonly Searcher[] {
  const probes: readonly Probe[] = searching
    .map((searcher) => probeOf(searcher, world.floor.tables))
    .toSorted((a, b) => a.roll - b.roll);

  for (const probe of probes) {
    const { party } = probe.searcher;
    if (!world.floor.accepts(probe.tableIndex, party.partySize)) continue;
    if (decidesNoShow(party, now - party.arriveAt, world.scenario)) {
      world.ended.gaveUp(party.ticketId, now);
      continue;
    }
    world.floor.sit(probe.tableIndex, party.partySize, now, now + party.stay);
    world.ended.sat(party.ticketId, now);
  }
  return searching.filter((searcher) => !world.ended.done(searcher.party.ticketId));
}

/** 1 回の覗き。**1 つの目から、覗く先と順番の両方を作る。** */
function probeOf(searcher: Searcher, tables: number): Probe {
  const roll: number = searcher.rng.next();
  return { searcher, tableIndex: Math.min(Math.floor(roll * tables), tables - 1), roll };
}

interface Finished {
  readonly scenario: Scenario;
  readonly seed: number;
  readonly scanRatePerMin: number;
  readonly parties: readonly Party[];
  readonly ended: Outcomes;
  readonly floor: Floor;
  readonly endedAt: Timestamp;
}

function report(finished: Finished): BaselineResult {
  const { scenario, floor, endedAt } = finished;
  const window: DurationMs = endedAt - SIM_EPOCH;
  return {
    scenario: scenario.name,
    seed: finished.seed,
    scanRatePerMin: finished.scanRatePerMin,
    searches: finished.parties.map((party) => ({
      ticketId: party.ticketId,
      partySize: party.partySize,
      arriveAt: party.arriveAt,
      ...finished.ended.of(party.ticketId),
    })),
    ...floor.used,
    tableMs: window * floor.tables,
    endedAt,
  };
}
