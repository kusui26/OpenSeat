/**
 * 座席 QR を読んだときの分岐（全体プラン 7.8）。
 *
 * **同じ QR が、受付・着席・退席・報告のすべてを兼ねる。** 何が起きるかは
 * 「読み取った人の状態」と「席の状態」の組み合わせで決まる。その組み合わせは
 * 7 × 7 = 49 通りあり、**どれかを書き忘れると画面が固まる。** だから分岐を
 * 1 か所に集め、型の上で総当たりになる形にしてある。
 *
 * ```ts
 * const outcome = resolveTableScan(state, tableId, ticketId);
 * // outcome.kind   … 何を見せるか
 * // outcome.actions … いま押せる操作（コマンドの種別）
 * ```
 *
 * **どの結果になるかは core が決める。** 画面は結果を描くだけで、業務判断を
 * しない（CLAUDE.md 3.1）。文言は Phase 2 の i18n が `kind` を鍵に持つ。
 *
 * **現在時刻を受け取らない。** 分岐はどれも状態だけで決まり、時間の経過を
 * 見るものが 1 つも無い。使わない引数は残さない（PR 4 と同じ方針）。
 *
 * **操作を出すかどうかは、コマンドが使うのと同じガードに聞く。** 画面の判定を
 * 別に書くと、「変更できます」と出したのに拒否される、といった食い違いが必ず
 * どこかで起きる。
 */

import type { TableId, TicketId } from '../domain/ids.js';
import { findTable, findTicket, type VenueState } from '../domain/state.js';
import { fitsCapacity, satisfiesTags, type Table, type TableStatus } from '../domain/table.js';
import { isTerminal, type Ticket, type TicketState } from '../domain/ticket.js';
import type { CommandType } from '../machine/command.js';
import { evaluateTicketGuard } from '../machine/guards.js';

/**
 * 読み取った人に見せるもの。
 *
 * | 種別 | 誰が読んだか | 席 | 出典 |
 * |---|---|---|---|
 * | `check_in` | 呼ばれていて、この席が自分の席 | 確保中 | 7.8 の 1・10 |
 * | `swap_offer` | 呼ばれていて、別の席が自分の席 | 空席で収まる | 7.8 の 2 |
 * | `other_table` | 呼ばれていて、別の席が自分の席 | 移れない | 7.8 の 3 |
 * | `early_check_in` | 待っている | 空席で、順番を崩さずに座れる | 7.8 の 4 |
 * | `keep_waiting` | 待っている | 上記以外 | （7.8 に無い。順番をお待ちください） |
 * | `resume_first` | 保留中 | どれでも | （7.8 に無い。まず「準備OK」） |
 * | `seated_here` | 着席中で、この席が自分の席 | 利用中 | 7.8 の 5 |
 * | `seated_elsewhere` | 着席中で、別の席が自分の席 | どれでも | （7.8 に無い） |
 * | `walk_in_offer` | チケットなし | 空席で、収まる待ちがいない | 7.8 の 6 ／ 7.12 |
 * | `queue_first` | チケットなし | 空席だが待ちがいる | 7.8 の 7 |
 * | `held_for_other` | チケットなし | 確保中 | 7.8 の 8 |
 * | `in_use` | チケットなし | 使用中 | 7.8 の 9 |
 * | `needs_check` | チケットなし | 空いている可能性が高い | 7.11 の 3 層目 |
 * | `turnover` | チケットなし | 片付け中 | 7.6 |
 * | `not_managed` | チケットなし | 対象外 | 7.14 |
 */
export const TABLE_SCAN_KINDS = [
  'check_in',
  'swap_offer',
  'other_table',
  'early_check_in',
  'keep_waiting',
  'resume_first',
  'seated_here',
  'seated_elsewhere',
  'walk_in_offer',
  'queue_first',
  'held_for_other',
  'in_use',
  'needs_check',
  'turnover',
  'not_managed',
] as const;

export type TableScanKind = (typeof TABLE_SCAN_KINDS)[number];

export interface TableScanOutcome {
  readonly kind: TableScanKind;
  /** 読み取った席。 */
  readonly tableId: TableId;
  /** その人に案内されている席。`other_table` のとき、ここへ導く。 */
  readonly assignedTableId: TableId | null;
  /**
   * いま押せる操作。空なら見せるだけ。
   *
   * ここに並ぶのは必ず実在するコマンドの種別で、そのまま `apply` に渡せる形
   * （引数は画面が組み立てる）。**画面が独自に操作を足さない**ための約束である。
   */
  readonly actions: readonly CommandType[];
  /**
   * 持っていたチケットがもう終わっているか（全体プラン 7.7 の 8）。
   *
   * ノーショーや期限切れのあとで席に来た人がこれにあたる。「この呼び出しは
   * 無効になっています」と伝えたうえで、チケットが無い人と同じ扱いにする。
   */
  readonly staleTicket: boolean;
}

const NO_ACTIONS: readonly CommandType[] = [];

function outcome(
  kind: TableScanKind,
  tableId: TableId,
  actions: readonly CommandType[],
  assignedTableId: TableId | null,
  staleTicket: boolean,
): TableScanOutcome {
  return { kind, tableId, assignedTableId, actions, staleTicket };
}

// ---- チケットを持たない人（7.8 の 6〜9、7.11、7.6、7.14） ----

/**
 * 席の状態だけで決まる分岐。
 *
 * **`TableStatus` を鍵にした総当たりの表**にしてあるので、席の状態を足したら
 * ここも埋めなければ型が通らない。書き忘れて画面が固まることが起こらない。
 */
const WITHOUT_TICKET: Readonly<
  Record<TableStatus, (state: VenueState, table: Table) => readonly [TableScanKind, readonly CommandType[]]>
> = {
  /** 対象外の席。順番待ちとは関係なく、自由に使ってよい。 */
  DISABLED: () => ['not_managed', NO_ACTIONS],

  /**
   * 空席。待っている人がこの席に収まるなら、その人が先である（7.8 の 7）。
   * 誰も収まらないなら、その場で座れる（7.12 の飛び込み着席）。
   */
  FREE: (state, table) =>
    hasWaiterFor(state, table) ? ['queue_first', NO_ACTIONS] : ['walk_in_offer', ['WALK_IN']],

  /** 呼び出し中のお客様の席。まもなく着席予定。 */
  HELD: () => ['held_for_other', NO_ACTIONS],

  /** 誰が使っているか分かっている席。第三者は動かせない。 */
  OCCUPIED: () => ['in_use', NO_ACTIONS],

  /** 誰かが使っているが誰かは分からない席。空いていれば報告できる（7.8 の 9）。 */
  OCCUPIED_UNKNOWN: () => ['in_use', ['CONFIRM_FREE']],

  /** 退席直後の片付け中。 */
  TURNOVER: () => ['turnover', NO_ACTIONS],

  /** 空いている可能性が高い席。どちらかを押してもらって解消する（7.11 の 3 層目）。 */
  NEEDS_CHECK: () => ['needs_check', ['CONFIRM_FREE', 'REPORT_IN_USE']],
};

/** その席に収まる待ちの人がいるか。いれば、その人のほうが先である。 */
function hasWaiterFor(state: VenueState, table: Table): boolean {
  return state.tickets.some(
    (ticket) =>
      ticket.state === 'WAITING' &&
      fitsCapacity(table, ticket.partySize) &&
      satisfiesTags(table, ticket.requiredTags),
  );
}

// ---- チケットを持つ人（7.8 の 1〜5、7.11 の 3 層目） ----

interface ScanContext {
  readonly state: VenueState;
  readonly table: Table;
  readonly ticket: Ticket;
}

/**
 * チケットの状態だけで分かれる。こちらも総当たりの表にしてある。
 *
 * 終端の状態（`DONE` など）はここに来ない。呼び出しが無効になった人は、
 * チケットを持たない人として扱う（7.7 の 8）。
 */
const WITH_TICKET: Readonly<
  Record<'WAITING' | 'PAUSED' | 'CALLED' | 'SEATED', (context: ScanContext) => TableScanOutcome>
> = {
  WAITING: waitingScan,
  PAUSED: ({ table, ticket }) =>
    outcome('resume_first', table.id, ['READY'], ticket.tableId, false),
  CALLED: calledScan,
  SEATED: ({ table, ticket }) =>
    ticket.tableId === table.id
      ? outcome('seated_here', table.id, ['CHECK_OUT'], table.id, false)
      : outcome('seated_elsewhere', table.id, NO_ACTIONS, ticket.tableId, false),
};

/**
 * その操作が通るかを、**コマンドが使うのと同じガードに聞く**。
 *
 * 画面の判定とコマンドの判定を別々の式で書くと、必ずどこかで食い違う。
 * 「変更できます」と出したのに拒否される、あるいはその逆が起きる。
 * 出す／出さないの根拠を 1 か所（`machine/guards.ts`）に寄せてある。
 */
function guardPasses(context: ScanContext, guard: 'swapAllowed' | 'earlyCheckInAllowed'): boolean {
  const { state, ticket, table } = context;
  return evaluateTicketGuard({ state, ticket, table, now: 0 }, guard);
}

/** 呼び出されている人（7.8 の 1〜3、10）。 */
function calledScan(context: ScanContext): TableScanOutcome {
  const { table, ticket } = context;
  if (ticket.tableId === table.id) {
    // 座るか、誰かが座っていたと報告するか。7.8 の 1 行目と 10 行目は
    // 同じ画面の 2 つのボタンにあたる。
    return outcome('check_in', table.id, ['CHECK_IN', 'REPORT_TAKEN'], table.id, false);
  }
  return guardPasses(context, 'swapAllowed')
    ? outcome('swap_offer', table.id, ['SWAP_TABLE'], ticket.tableId, false)
    : outcome('other_table', table.id, NO_ACTIONS, ticket.tableId, false);
}

/** 待っている人（7.8 の 4、7.11 の 3 層目）。 */
function waitingScan(context: ScanContext): TableScanOutcome {
  const { table } = context;
  if (table.status === 'NEEDS_CHECK') return uncertainScan(context);
  return guardPasses(context, 'earlyCheckInAllowed')
    ? outcome('early_check_in', table.id, ['CHECK_IN_EARLY'], null, false)
    : outcome('keep_waiting', table.id, NO_ACTIONS, null, false);
}

/**
 * 「空いている可能性が高い席」に来た人（7.11 の 3 層目）。
 *
 * 画面に出す言葉は同じでも、押せるものが 2 通りある。
 *
 * | 誰か | 空いていたとき | 使われていたとき |
 * |---|---|---|
 * | この席を案内された人 | `CHECK_IN_EARLY`（そのまま座る） | `REPORT_IN_USE` |
 * | それ以外の待っている人 | `CONFIRM_FREE`（空席として知らせる） | `REPORT_IN_USE` |
 *
 * **案内された人だけがそのまま座れる。** 7.11 は「着席されれば解消」と書いて
 * おり、確かめに行った人がその席を得られなければ「歩き回って探す」より悪く
 * なってしまう。座れば、ほかの誰かに渡る隙が無い。
 */
function uncertainScan(context: ScanContext): TableScanOutcome {
  const { table } = context;
  const actions: readonly CommandType[] = guardPasses(context, 'earlyCheckInAllowed')
    ? ['CHECK_IN_EARLY', 'REPORT_IN_USE']
    : ['CONFIRM_FREE', 'REPORT_IN_USE'];
  return outcome('needs_check', table.id, actions, null, false);
}

// ---- 入口 ----

/**
 * 座席 QR を読んだときに、その人に何を見せ、何ができるかを決める。
 *
 * `ticketId` は読み取った人のチケット。持っていなければ `null`。座席トークンから
 * `TableId` への解決は境界側の責務で、`core` は解決済みの ID を受け取る。
 *
 * 席が見つからなければ `null` を返す。壊れた QR や、外された席の QR にあたる。
 */
export function resolveTableScan(
  state: VenueState,
  tableId: TableId,
  ticketId: TicketId | null,
): TableScanOutcome | null {
  const table: Table | undefined = findTable(state, tableId);
  if (table === undefined) return null;

  const ticket: Ticket | undefined = ticketId === null ? undefined : findTicket(state, ticketId);
  const stale: boolean = ticket !== undefined && isTerminal(ticket.state);
  if (ticket === undefined || stale) return withoutTicket(state, table, stale);

  // 対象外の席でも、そこに座っている人は退席できる。閉じ込めない。
  if (!table.enabled || table.status === 'DISABLED') {
    return ticket.state === 'SEATED' && ticket.tableId === table.id
      ? outcome('seated_here', table.id, ['CHECK_OUT'], table.id, false)
      : outcome('not_managed', table.id, NO_ACTIONS, ticket.tableId, false);
  }
  return WITH_TICKET[activeStateOf(ticket)]({ state, table, ticket });
}

function withoutTicket(state: VenueState, table: Table, stale: boolean): TableScanOutcome {
  const [kind, actions] = WITHOUT_TICKET[table.status](state, table);
  return outcome(kind, table.id, actions, null, stale);
}

/** 終端でないことは呼び出し側が確かめている。型を絞るためだけの関数。 */
function activeStateOf(ticket: Ticket): 'WAITING' | 'PAUSED' | 'CALLED' | 'SEATED' {
  const state: TicketState = ticket.state;
  if (state === 'PAUSED') return 'PAUSED';
  if (state === 'CALLED') return 'CALLED';
  if (state === 'SEATED') return 'SEATED';
  return 'WAITING';
}
