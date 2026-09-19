/**
 * 施設の状態。
 *
 * `apply` と `tick` が受け取り、新しい状態を返す対象（ADR-0004）。
 * 破壊的な更新はしない。
 *
 * テーブルとチケットは配列で持つ。1 施設あたり席 20〜100、生きているチケットは
 * 200 程度（全体プラン 9.1）なので線形走査で足りる。引き当てはこのファイルの
 * ヘルパーに閉じ込めてあるので、規模が変わったときに差し替えられる。
 */

import type { Policy } from './policy.js';
import type { Table } from './table.js';
import type { TableId, TicketCode, TicketId, VenueId } from './ids.js';
import type { Ticket, TicketState } from './ticket.js';
import type { Timestamp } from '../time.js';
import { isActive } from './ticket.js';

export interface VenueState {
  readonly venueId: VenueId;

  readonly tables: readonly Table[];

  /**
   * チケット。終端に達したものも履歴として残る。
   * 生きているものだけが欲しい場合は `activeTickets()` を使う。
   */
  readonly tickets: readonly Ticket[];

  readonly policy: Policy;

  /**
   * 運用中か。スケジュールまたはスタッフの手動操作で切り替わる（全体プラン 7.14）。
   * 運用外では対象席が `DISABLED` になり、自由席に戻る。
   */
  readonly operating: boolean;

  /**
   * 新規の受付を受け付けているか。
   * 運用終了の手前で止めるため、`operating` とは別に持つ。
   */
  readonly joinOpen: boolean;

  /**
   * いまの営業回が終わる時刻（全体プラン 7.14）。運用終了を持たないなら `null`。
   *
   * **曜日と時間帯の設定（`managed_schedule`）はここに持たない。** 施設の
   * タイムゾーンでの評価は境界側の責務で（9.4）、core が受け取るのは解決済みの
   * 絶対時刻 1 つだけである。こうしてあるので、**運用終了がホールドの期限や
   * 保留の期限とまったく同じ仕組みで処理できる**（`machine/deadlines.ts`）。
   *
   * 運用が終わったあとも消さない。終了後に呼び出しが流れて待ちに戻る人
   * （ノーショーの繰り上げなど）を、次の `tick` で拾うためである。次の `OPEN`
   * で置き換わる。
   */
  readonly closesAt: Timestamp | null;

  /**
   * この状態が知っている最後の時刻（全体プラン 9.4）。まだ一度も進めていなければ `null`。
   *
   * **時計が戻っていないことを確かめるためだけに持つ。** 期限の判定はすべて
   * 「状態に書いてある絶対時刻」と `now` の比較なので、時計が戻ると過ぎた期限が
   * また「これから」に戻ってしまう（`machine/clock.ts`）。
   */
  readonly clockAt: Timestamp | null;

  /** 表示コードの採番カウンタ。0 から始まる。 */
  readonly nextCodeSeq: number;
}

export interface CreateVenueStateParams {
  readonly venueId: VenueId;
  readonly policy: Policy;
  readonly tables?: readonly Table[];
}

/** 空の状態を作る。席は別途追加する。 */
export function createVenueState(params: CreateVenueStateParams): VenueState {
  return {
    venueId: params.venueId,
    tables: params.tables ?? [],
    tickets: [],
    policy: params.policy,
    operating: false,
    joinOpen: false,
    closesAt: null,
    clockAt: null,
    nextCodeSeq: 0,
  };
}

// ---- 引き当て ----

export function findTable(state: VenueState, id: TableId): Table | undefined {
  return state.tables.find((table) => table.id === id);
}

export function findTicket(state: VenueState, id: TicketId): Ticket | undefined {
  return state.tickets.find((ticket) => ticket.id === id);
}

/** 終端に達していないチケット。 */
export function activeTickets(state: VenueState): readonly Ticket[] {
  return state.tickets.filter((ticket) => isActive(ticket.state));
}

/** 割当の対象になっているチケット。順番は保証しない。 */
export function waitingTickets(state: VenueState): readonly Ticket[] {
  return state.tickets.filter((ticket) => ticket.state === 'WAITING');
}

/**
 * 待ち行列に並んでいるチケット（全体プラン 7.16 の `max_queue_length`）。
 *
 * 待っている人（`WAITING`）、順番を保持したまま保留している人（`PAUSED`）、
 * 席が確保されていてまだ座っていない人（`CALLED`）を数える。着席した人は
 * 行列から出ているので含めない。
 */
export function queuedTickets(state: VenueState): readonly Ticket[] {
  return state.tickets.filter((ticket) => QUEUED_STATES.has(ticket.state));
}

const QUEUED_STATES: ReadonlySet<TicketState> = new Set<TicketState>(['WAITING', 'PAUSED', 'CALLED']);

/** 管理対象の席。 */
export function managedTables(state: VenueState): readonly Table[] {
  return state.tables.filter((table) => table.enabled);
}

// ---- 表示コードの採番 ----

const CODE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CODES_PER_LETTER = 99;

/** 重複せずに発行できるコードの総数。 */
export const CODE_SPACE_SIZE = CODE_LETTERS.length * CODES_PER_LETTER;

/**
 * `nextCodeSeq` から表示コードを導く。
 *
 * `A-01` から `A-99`、`B-01` と続き、`Z-99` の次は `A-01` に戻る。
 * 2,574 通りあるので 1 日の運用で重複しない。乱数を使わず状態から決まるため、
 * `core` の純粋性を保ったまま採番できる（ADR-0004）。
 */
export function ticketCodeFor(seq: number): TicketCode {
  const wrapped: number = ((seq % CODE_SPACE_SIZE) + CODE_SPACE_SIZE) % CODE_SPACE_SIZE;
  const letter: string = CODE_LETTERS.charAt(Math.floor(wrapped / CODES_PER_LETTER));
  const slot: number = (wrapped % CODES_PER_LETTER) + 1;
  return `${letter}-${String(slot).padStart(2, '0')}`;
}

/** 次に発行する表示コード。採番カウンタを進めるのは呼び出し側の責務。 */
export function nextTicketCode(state: VenueState): TicketCode {
  return ticketCodeFor(state.nextCodeSeq);
}

/** 発行できる表示コードと、その次の採番位置。空きが無ければ null。 */
export interface CodeAllocation {
  readonly code: TicketCode;
  readonly nextSeq: number;
}

/**
 * 生きているチケットが使っていない表示コードを 1 つ選ぶ。
 *
 * カウンタを進めるだけでは、一巡したときに使用中のコードとぶつかる。そのときは
 * `unique_active_codes` が破れて受付ができなくなるので、使用中のものを飛ばす。
 * 2,574 通りすべてが埋まっていれば `null` を返す（席 100・待ち上限 100 の運用では
 * 起こらないが、上限を極端に上げた施設では起こりうる）。
 */
export function allocateTicketCode(state: VenueState): CodeAllocation | null {
  const inUse: ReadonlySet<TicketCode> = new Set(activeTickets(state).map((ticket) => ticket.code));
  for (let step = 0; step < CODE_SPACE_SIZE; step += 1) {
    const seq: number = state.nextCodeSeq + step;
    const code: TicketCode = ticketCodeFor(seq);
    if (!inUse.has(code)) return { code, nextSeq: seq + 1 };
  }
  return null;
}

// ---- 受け付けられる最大人数 ----

/**
 * 受け付けられる最大人数。
 *
 * `policy.maxPartySize` が設定されていればそれを使い、無ければ対象席の
 * 最大定員から導く（全体プラン 7.16）。対象席が 1 つも無ければ 0 を返す。
 */
export function effectiveMaxPartySize(state: VenueState): number {
  const explicit: number | null = state.policy.maxPartySize;
  if (explicit !== null) return explicit;
  const capacities: readonly number[] = managedTables(state).map((table) => table.capacity);
  return capacities.length === 0 ? 0 : Math.max(...capacities);
}

// ---- 更新のヘルパー ----

/** 1 つのテーブルを差し替えた状態を返す。 */
export function withTable(state: VenueState, updated: Table): VenueState {
  return {
    ...state,
    tables: state.tables.map((table) => (table.id === updated.id ? updated : table)),
  };
}

/** 1 つのチケットを差し替えた状態を返す。 */
export function withTicket(state: VenueState, updated: Ticket): VenueState {
  return {
    ...state,
    tickets: state.tickets.map((ticket) => (ticket.id === updated.id ? updated : ticket)),
  };
}

// ---- 状態の比較 ----

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** 席そのものの性質（運用で変わらない部分）が同じか。 */
function sameTableDefinition(a: Table, b: Table): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.capacity === b.capacity &&
    a.adminRank === b.adminRank &&
    a.enabled === b.enabled &&
    sameStrings(a.tags, b.tags)
  );
}

/** 席の使われ方（運用で変わる部分）が同じか。 */
function sameTableUsage(a: Table, b: Table): boolean {
  return (
    a.status === b.status &&
    a.statusSince === b.statusSince &&
    a.verifiedFreeAt === b.verifiedFreeAt &&
    a.occupantTicketId === b.occupantTicketId &&
    a.disableAfterCurrent === b.disableAfterCurrent
  );
}

/** 2 つのテーブルが同じ内容か。 */
export function sameTable(a: Table, b: Table): boolean {
  return sameTableDefinition(a, b) && sameTableUsage(a, b);
}

function sameTicketIdentity(a: Ticket, b: Ticket): boolean {
  return (
    a.id === b.id &&
    a.code === b.code &&
    a.partySize === b.partySize &&
    a.state === b.state &&
    sameStrings(a.requiredTags, b.requiredTags)
  );
}

/** 順番と、呼び出し・着席・終了の時刻が同じか。 */
function sameTicketProgress(a: Ticket, b: Ticket): boolean {
  return (
    a.priorityAt === b.priorityAt &&
    a.createdAt === b.createdAt &&
    a.calledAt === b.calledAt &&
    a.holdDeadline === b.holdDeadline &&
    a.holdRemindedAt === b.holdRemindedAt &&
    a.seatedAt === b.seatedAt &&
    a.endedAt === b.endedAt
  );
}

/** 保留と、利用者の画面との接続に関する時刻が同じか。 */
function sameTicketPresence(a: Ticket, b: Ticket): boolean {
  return (
    a.pauseDeadline === b.pauseDeadline &&
    a.pausedSince === b.pausedSince &&
    a.pausedTotal === b.pausedTotal &&
    a.lastSeenAt === b.lastSeenAt &&
    a.stillHereAskedAt === b.stillHereAskedAt &&
    a.stillHereAnsweredAt === b.stillHereAnsweredAt &&
    a.timeLimitNoticedAt === b.timeLimitNoticedAt
  );
}

function sameTicketCounters(a: Ticket, b: Ticket): boolean {
  return (
    a.tableId === b.tableId &&
    a.extensions === b.extensions &&
    a.passes === b.passes &&
    a.noShows === b.noShows &&
    a.conflictPriority === b.conflictPriority &&
    a.endReason === b.endReason &&
    a.hasNotificationChannel === b.hasNotificationChannel
  );
}

/** 2 つのチケットが同じ内容か。 */
export function sameTicket(a: Ticket, b: Ticket): boolean {
  return (
    sameTicketIdentity(a, b) &&
    sameTicketProgress(a, b) &&
    sameTicketPresence(a, b) &&
    sameTicketCounters(a, b)
  );
}

/**
 * 2 つの状態が同じ内容か。
 *
 * `tick` の冪等性（全体プラン 9.12 の 5）と、時間の飛ばし方によらず同じ状態に
 * 落ち着くこと（PR 12）を確かめるために使う。
 *
 * **運用パラメータは参照で比べる。** `apply` と `tick` は設定を作り直さない
 * （展開すると参照は保たれる）ため、参照が変わっていれば実装の誤りである。
 * 値で比べるより厳しい判定になるが、厳しい側に外れるぶんには見落としが出ない。
 */
export function sameVenueState(a: VenueState, b: VenueState): boolean {
  return sameVenueFields(a, b) && sameTables(a, b) && sameTickets(a, b);
}

/** 施設そのものの欄。席とチケットは別に比べる。 */
function sameVenueFields(a: VenueState, b: VenueState): boolean {
  return (
    a.venueId === b.venueId &&
    a.operating === b.operating &&
    a.joinOpen === b.joinOpen &&
    a.closesAt === b.closesAt &&
    a.clockAt === b.clockAt &&
    a.nextCodeSeq === b.nextCodeSeq &&
    a.policy === b.policy
  );
}

function sameTables(a: VenueState, b: VenueState): boolean {
  return (
    a.tables.length === b.tables.length &&
    a.tables.every((table, index) => matchesAt(b.tables, index, table, sameTable))
  );
}

function sameTickets(a: VenueState, b: VenueState): boolean {
  return (
    a.tickets.length === b.tickets.length &&
    a.tickets.every((ticket, index) => matchesAt(b.tickets, index, ticket, sameTicket))
  );
}

function matchesAt<T>(
  list: readonly T[],
  index: number,
  value: T,
  equals: (a: T, b: T) => boolean,
): boolean {
  const other = list[index];
  return other !== undefined && equals(value, other);
}
