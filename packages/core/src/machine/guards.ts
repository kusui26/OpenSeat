/**
 * 遷移の条件（ガード）の判定。
 *
 * 遷移表（`ticket-machine.ts`、`table-machine.ts`）はガードの **名前** だけを
 * 宣言する。ここはその名前に判定を与える層である。分けてあるのは、表が
 * 「何が起こりうるか」だけを語り、「いま起こるか」の判断が振る舞いの側に
 * 閉じるようにするためである。
 *
 * **まだ実装されていないガードは、成立しないものとして扱う。** 判定を書き忘れた
 * 遷移が黙って通るより、拒否されて止まるほうが安全である（CLAUDE.md 2.1）。
 * 拒否の理由は `BLOCKED_BY_GUARD` ではなく `GUARD_NOT_IMPLEMENTED` になるので、
 * 「条件を満たさなかった」と「まだ書いていない」は呼び出し側から区別できる。
 *
 * 宣言されたガードがすべて実装されていることは PR 12 で閉じる。
 * それまでのあいだ、残りは `unimplementedTicketGuards()` が数え上げる。
 */

import { fitsCapacity, satisfiesTags, type Table } from '../domain/table.js';
import type { VenueState } from '../domain/state.js';
import type { Ticket } from '../domain/ticket.js';
import type { Timestamp } from '../time.js';
import { canExtendHold } from './deadlines.js';
import { TICKET_GUARDS, type TicketGuard } from './ticket-machine.js';
import { TABLE_GUARDS, type TableGuard } from './table-machine.js';

/**
 * チケットのガードが見てよいもの。
 *
 * `table` は操作の対象になっている席。呼び出し（どの席へ案内するか）、着席
 * （読み取った席が自分のものか）、席の変更で要る。対象が無い遷移では `null`。
 */
export interface TicketGuardContext {
  readonly state: VenueState;
  readonly ticket: Ticket;
  readonly now: Timestamp;
  readonly table: Table | null;
}

/** 席のガードが見てよいもの。 */
export interface TableGuardContext {
  readonly state: VenueState;
  readonly table: Table;
  readonly now: Timestamp;
}

type TicketGuardPredicate = (context: TicketGuardContext) => boolean;

/**
 * 実装済みのチケットのガード。
 *
 * 残り 3 つ（`earlyCheckInAllowed`、`swapAllowed`、`hardLimitMode`）は
 * 座席 QR の分岐（PR 9）と着席時間の上限（PR 10）で埋める。
 */
const TICKET_GUARD_PREDICATES: Partial<Readonly<Record<TicketGuard, TicketGuardPredicate>>> = {
  /** 案内しようとしている席に人数が収まり、希望タグを満たすか（7.6）。 */
  fitsCapacity: ({ ticket, table }) =>
    table !== null && fitsCapacity(table, ticket.partySize) && satisfiesTags(table, ticket.requiredTags),

  /**
   * 読み取った席が、自分に割り当てられた席か（7.8 の 1 行目）。
   *
   * 座席 QR のトークンから `TableId` への解決は境界側の責務で、`core` は
   * 解決済みの ID だけを受け取る（`table.ts` の冒頭）。ここで見るのは
   * 「その ID が自分の席か」だけである。
   */
  isAssignedTable: ({ ticket, table }) => table !== null && ticket.tableId === table.id,

  /** 「向かっています」をまだ押せるか（7.7 の 4）。 */
  underExtensionLimit: ({ ticket, state }) => canExtendHold(ticket, state.policy),

  /** ホールドの期限切れ 1 回目を、順番を保持したまま保留に戻す設定か（7.7 の 6）。 */
  requeueOnNoShow: ({ ticket, state }) =>
    state.policy.noShowPolicy === 'requeue_once' && ticket.noShows === 0,

  /** ホールドの期限切れで順番を末尾に戻す設定か（7.7 の 6）。 */
  requeueToBackOnNoShow: ({ state }) => state.policy.noShowPolicy === 'requeue_back',

  /** ホールドの期限切れで終了する場面か（7.7 の 6）。 */
  finalNoShow: ({ ticket, state }) =>
    state.policy.noShowPolicy === 'cancel' ||
    (state.policy.noShowPolicy === 'requeue_once' && ticket.noShows >= 1),

  /**
   * 通知手段を持っていないか（7.9）。
   *
   * 「接続が切れてから何分たったか」はここでは見ない。**時間の経過は期限が
   * 表す**（`abandonedAt`）。ほかの時刻起因の遷移（ホールドの期限切れなど）も
   * 同じで、ガードは「どちらへ進むか」だけを決め、「いつ進むか」は期限が決める。
   */
  noNotificationChannel: ({ ticket }) => !ticket.hasNotificationChannel,
};

/**
 * 実装済みの席のガード。
 *
 * 残る `autoFreeEnabled` は「確認要」の自動解放（PR 10）で使う。
 */
const TABLE_GUARD_PREDICATES: Partial<
  Readonly<Record<TableGuard, (context: TableGuardContext) => boolean>>
> = {
  /** 対象外にする操作が保留されているか（7.6 のエッジケース）。 */
  disableAfterCurrent: ({ table }) => table.disableAfterCurrent,

  /** 対象外の予約が無く、引き続き管理対象か。`disableAfterCurrent` の裏返し。 */
  stillManaged: ({ table }) => !table.disableAfterCurrent,
};

/** そのガードの判定が書かれているか。 */
export function ticketGuardIsImplemented(guard: TicketGuard): boolean {
  return TICKET_GUARD_PREDICATES[guard] !== undefined;
}

/** そのガードの判定が書かれているか。 */
export function tableGuardIsImplemented(guard: TableGuard): boolean {
  return TABLE_GUARD_PREDICATES[guard] !== undefined;
}

/** 判定がまだ書かれていないチケットのガード。PR 12 で空になる。 */
export function unimplementedTicketGuards(): readonly TicketGuard[] {
  return TICKET_GUARDS.filter((guard) => !ticketGuardIsImplemented(guard));
}

/** 判定がまだ書かれていない席のガード。PR 12 で空になる。 */
export function unimplementedTableGuards(): readonly TableGuard[] {
  return TABLE_GUARDS.filter((guard) => !tableGuardIsImplemented(guard));
}

/** ガードが成立するか。判定が無ければ成立しない。 */
export function evaluateTicketGuard(context: TicketGuardContext, guard: TicketGuard): boolean {
  const predicate = TICKET_GUARD_PREDICATES[guard];
  return predicate === undefined ? false : predicate(context);
}

/** ガードが成立するか。判定が無ければ成立しない。 */
export function evaluateTableGuard(context: TableGuardContext, guard: TableGuard): boolean {
  const predicate = TABLE_GUARD_PREDICATES[guard];
  return predicate === undefined ? false : predicate(context);
}
