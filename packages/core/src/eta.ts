/**
 * 待ち時間の推定（全体プラン 7.13）。
 *
 * **状態を変えない問い合わせである。** 使う場面は 2 つ。受付の前に「それでも
 * 並びますか」を出すとき（7.5 の 5）と、並んでいる人の画面に「前に 4 組、
 * 約 10〜15 分」を出すときである。
 *
 * ## 考え方
 *
 * その人数が収まる席それぞれについて「あと何分で空くか」（`r_t`）を見積もり、
 * 早い順に並べる。自分より前に並んでいて同じ席を取り合う組が `k` 組いるなら、
 * その `k` 組が先に取っていくので、自分に回るのは **`k + 1` 番目**である。
 *
 * **席数より待ちが多いときは、席が回るのを待つ。** 前の人が入った席は、滞在の
 * ぶんだけまた埋まる。7.13 の式は `k` が席数より小さい場合しか書いていないが、
 * **過負荷のときこそ数字が要る**（7.5 の 5 は「40 分以上お待ちいただく見込みです」
 * を出す）。`k` が席数より小さければ、7.13 の式とまったく同じ結果になる。
 *
 * ## 悲観側に寄せる（7.13）
 *
 * 早く案内されるのは嬉しく、遅れるのは不満なので、迷ったら長いほうを採る。
 *
 * - **確証の無い席は、システムが空けると決めている時刻で数える。** 「確認要」は
 *   自動解放まで、「使用中（誰か不明）」は確認要に落ちてから自動解放まで
 *   （7.11 の 5 層目）。新しい仮定を置かずに済み、席の状態が移っても数字が
 *   跳ねない。**期限の式は `machine/deadlines.ts` と同じものを使う**ので、
 *   `tick` が実際に席を空ける時刻と、見積もりが食い違うことがない
 * - 自動解放を切っている施設（`needs_check_auto_free_min` が `null`）には、その
 *   期限が無い。7.11 の「最悪でも席が永久に塞がらない」も成り立たなくなるので、
 *   使用中の席と同じ見積もりに落とす
 * - **保留中の人も「前の組」に数える。** 順番は保持されているので、戻ってくれば
 *   自分より先に案内される（7.7 の 5）
 * - 呼び出し中の人は数えない。その人の席はもう確保されていて、`r_t` の側に
 *   「ホールドの残り＋滞在」として織り込んである
 *
 * ## ここでやらないこと
 *
 * 施設ごとの滞在時間の分布を使う推定（7.13 の v1.1）と、予測と実績の差の記録は
 * ここには置かない。前者は実測が溜まってから、後者は境界側の仕事である。
 */

import type { Tag } from './domain/ids.js';
import type { Policy } from './domain/policy.js';
import type { VenueState } from './domain/state.js';
import { fitsCapacity, satisfiesTags, type Table, type TableStatus } from './domain/table.js';
import { comparePriority, type Ticket, type TicketState } from './domain/ticket.js';
import { autoFreeAt, turnoverEndsAt, unknownAgedAt } from './machine/deadlines.js';
import { MINUTE_MS, minutes, remaining, type DurationMs, type Timestamp } from './time.js';

/** 待ち時間の目安（全体プラン 7.13）。 */
export type WaitEstimate =
  /** その人数が収まる席が、いま 1 つも無い。運用していない時間帯もこれになる。 */
  | { readonly kind: 'no_seat' }
  /** 並んでいない人。すでに席が決まっているか、終わっている。 */
  | { readonly kind: 'not_waiting' }
  | {
      readonly kind: 'estimate';
      /** 目安の分数。分単位に切り上げてある（悲観側）。 */
      readonly minutes: number;
      /** 表示する幅の下限。`etaBucketMin` の倍数で、0 なら「5 分未満」。 */
      readonly fromMin: number;
      /** 表示する幅の上限。`fromMin + etaBucketMin`。 */
      readonly toMin: number;
      /** 前に何組いるか（7.5 の画面「前に 4 組」）。 */
      readonly ahead: number;
    };

/** これから登録しようとしている組。 */
export interface PartyToSeat {
  readonly partySize: number;
  readonly requiredTags: readonly Tag[];
}

/** 並んでいるとみなす状態。保留中の人も順番を持っている（7.7 の 5）。 */
const QUEUED_STATES: readonly TicketState[] = ['WAITING', 'PAUSED'];

/**
 * これから登録する組の目安（7.5 の 5）。
 *
 * **いま並んでいる人は全員この組より前にいる。** 受付時刻が現在になるためで、
 * 「登録したらどれくらい待つか」をそのまま表す。
 */
export function estimateForJoin(
  state: VenueState,
  party: PartyToSeat,
  now: Timestamp,
): WaitEstimate {
  return estimate(state, { ...party, isAhead: () => true }, now);
}

/**
 * すでに並んでいる組の目安（チケット画面）。
 *
 * 保留中の人にも返す。「準備OK を押したらどれくらいか」を示す数字で、
 * 押すかどうかの判断に要るためである。
 */
export function estimateForTicket(
  state: VenueState,
  ticket: Ticket,
  now: Timestamp,
): WaitEstimate {
  if (!QUEUED_STATES.includes(ticket.state)) return { kind: 'not_waiting' };
  return estimate(
    state,
    {
      partySize: ticket.partySize,
      requiredTags: ticket.requiredTags,
      isAhead: (other) => other.id !== ticket.id && comparePriority(other, ticket) < 0,
    },
    now,
  );
}

/** 目安を求める人。「自分より前か」の判定だけが受付前と受付後で変わる。 */
interface Seeker extends PartyToSeat {
  readonly isAhead: (other: Ticket) => boolean;
}

function estimate(state: VenueState, seeker: Seeker, now: Timestamp): WaitEstimate {
  const seats: readonly Table[] = fittingTables(state, seeker);
  if (seats.length === 0) return { kind: 'no_seat' };

  const waits: readonly DurationMs[] = seats
    .map((table) => remainingFor(state, table, now))
    .toSorted((a, b) => a - b);
  const ahead: number = aheadCount(state, seeker, seats);
  return display(nextFreeFor(waits, ahead, minutes(state.policy.assumedStayMin)), ahead, state.policy);
}

/** その人数が収まる、いま運用している席（7.13 の `T_p`）。 */
function fittingTables(state: VenueState, seeker: Seeker): readonly Table[] {
  return state.tables.filter(
    (table) =>
      table.enabled &&
      table.status !== 'DISABLED' &&
      fitsCapacity(table, seeker.partySize) &&
      satisfiesTags(table, seeker.requiredTags),
  );
}

/**
 * 自分より前に並んでいて、同じ席を取り合う組の数（7.13 の `k`）。
 *
 * 「取り合う」は **自分の候補の席のどれかに、その人も入れる**ことを指す。
 * 6 名席しか使えない自分と、2 名席にしか興味が無い組は取り合わない。
 */
function aheadCount(state: VenueState, seeker: Seeker, seats: readonly Table[]): number {
  return state.tickets.filter(
    (ticket) =>
      QUEUED_STATES.includes(ticket.state) && seeker.isAhead(ticket) && competes(ticket, seats),
  ).length;
}

function competes(ticket: Ticket, seats: readonly Table[]): boolean {
  return seats.some(
    (table) => fitsCapacity(table, ticket.partySize) && satisfiesTags(table, ticket.requiredTags),
  );
}

/**
 * 自分の番が来るまでの時間。
 *
 * **席が空くたびに、前に並んでいる人から順に入っていく。** 入られた席は滞在の
 * ぶんだけまた埋まる。これを前の組数ぶん繰り返したあとで、いちばん早く空く席が
 * 自分の席になる。
 *
 * `k` が席数より小さければ、**7.13 の「`k + 1` 番目の `r_t`」と一致する**
 * （誰も 2 回目に入らないので、並べ替えただけになる）。席数を超えたぶんは
 * 回転を待つことになり、7.13 が書いていない過負荷の場面まで伸ばせる。
 *
 * **前の組が増えるほど遅くなることが、この作り方から保証される。** 取り出すのは
 * 常に最小で、戻すのはそれより滞在のぶんだけ後ろなので、最小値は下がらない。
 * 「何巡目か」で計算する形も試したが、**そちらは単調にならなかった**（確保中の
 * 席のように滞在より長く待つ席があると、巡が変わるところで目安が縮む）。
 */
function nextFreeFor(waits: readonly DurationMs[], ahead: number, stay: DurationMs): DurationMs {
  let queue: readonly DurationMs[] = waits;
  for (let taken = 0; taken < ahead; taken += 1) {
    queue = [...queue.slice(1), (queue[0] ?? 0) + stay].toSorted((a, b) => a - b);
  }
  return queue[0] ?? 0;
}

/**
 * 幅に丸めて返す（7.13 の `eta_display`）。
 *
 * **分は切り上げる。** 12 分 30 秒を「12 分」と言わない。幅は刻みの倍数まで
 * 下ろした下限と、その 1 刻み上を出すので、**目安そのものは必ず幅の中に入り、
 * 上限は目安を下回らない**（7.13 の「悲観側に寄せる」）。
 */
function display(wait: DurationMs, ahead: number, policy: Policy): WaitEstimate {
  const total: number = Math.ceil(wait / MINUTE_MS);
  const fromMin: number = Math.floor(total / policy.etaBucketMin) * policy.etaBucketMin;
  return { kind: 'estimate', minutes: total, fromMin, toMin: fromMin + policy.etaBucketMin, ahead };
}

// ---- 席ごとの見積もり（7.13 の `r_t`） ----

interface Seat {
  readonly state: VenueState;
  readonly table: Table;
  readonly policy: Policy;
  readonly now: Timestamp;
}

function remainingFor(state: VenueState, table: Table, now: Timestamp): DurationMs {
  return REMAINING_BY_STATUS[table.status]({ state, table, policy: state.policy, now });
}

/**
 * 席の状態ごとの見積もり。**総当たりの表にしてある**ので、状態を足したら
 * ここも埋めなければ型が通らない（`scan/resolve.ts` と同じ形）。
 */
const REMAINING_BY_STATUS: Readonly<Record<TableStatus, (seat: Seat) => DurationMs>> = {
  /** 運用から外れている席。`fittingTables` が除くので、ここには来ない。 */
  DISABLED: () => 0,

  /** いま空いている。 */
  FREE: () => 0,

  /** 片付けの猶予が明ければ空く（7.6）。猶予 0 分の施設ではその場で空く。 */
  TURNOVER: ({ table, policy, now }) => {
    const ends: Timestamp | null = turnoverEndsAt(table, policy);
    return ends === null ? 0 : remaining(ends, now);
  },

  /** 確保されている席。**呼び出した人が着いてから、さらに滞在する。** */
  HELD: ({ state, table, policy, now }) =>
    remaining(holdEndsAt(state, table, policy), now) + minutes(policy.assumedStayMin),

  /** 着席している席。想定滞在から経過ぶんを引く（7.13）。 */
  OCCUPIED: ({ state, table, policy, now }) => stayLeft(sittingSince(state, table), policy, now),

  /**
   * 誰が使っているか分からない席。
   *
   * この席は `unknown_occupancy_to_check_min` で「確認要」に落ち、そこから
   * `needs_check_auto_free_min` で空席に戻る（7.11 の 5 層目）。**システムが
   * 空けると決めている時刻**なので、そこまでの残りを使う。
   */
  OCCUPIED_UNKNOWN: ({ table, policy, now }) => {
    const aged: Timestamp | null = unknownAgedAt(table, policy);
    const autoFree: number | null = policy.needsCheckAutoFreeMin;
    if (aged === null || autoFree === null) return stayLeft(table.statusSince, policy, now);
    return remaining(aged + minutes(autoFree), now);
  },

  /**
   * 空いている可能性が高い席。
   *
   * 自動解放の時刻には空く（7.11 の 5 層目）。それより早く、案内された人が
   * 確かめて解消することも多いが、**確かなのは期限のほうだけ**なので期限で数える。
   * 自動解放を切っている施設では期限が無いので、使用中の席と同じに見積もる。
   */
  NEEDS_CHECK: ({ state, table, policy, now }) => {
    const freesAt: Timestamp | null = autoFreeAt(table, policy);
    return freesAt === null
      ? stayLeft(sittingSince(state, table), policy, now)
      : remaining(freesAt, now);
  },
};

/** ホールドが切れる時刻。延長ぶんも含めるため、チケットの期限を見る。 */
function holdEndsAt(state: VenueState, table: Table, policy: Policy): Timestamp {
  return occupantOf(state, table)?.holdDeadline ?? table.statusSince + minutes(policy.holdMin);
}

/** 着席の記録があればその時刻、無ければその状態になった時刻から数える。 */
function sittingSince(state: VenueState, table: Table): Timestamp {
  return occupantOf(state, table)?.seatedAt ?? table.statusSince;
}

function stayLeft(since: Timestamp, policy: Policy, now: Timestamp): DurationMs {
  return remaining(since + minutes(policy.assumedStayMin), now);
}

function occupantOf(state: VenueState, table: Table): Ticket | undefined {
  const id = table.occupantTicketId;
  return id === null ? undefined : state.tickets.find((ticket) => ticket.id === id);
}
