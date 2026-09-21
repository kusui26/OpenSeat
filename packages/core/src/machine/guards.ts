/**
 * 遷移の条件（ガード）の判定。
 *
 * 遷移表（`ticket-machine.ts`、`table-machine.ts`）はガードの **名前** だけを
 * 宣言する。ここはその名前に判定を与える層である。分けてあるのは、表が
 * 「何が起こりうるか」だけを語り、「いま起こるか」の判断が振る舞いの側に
 * 閉じるようにするためである。
 *
 * **判定の無いガードは、成立しないものとして扱う。** 書き忘れた遷移が黙って通る
 * より、拒否されて止まるほうが安全である（CLAUDE.md 2.1）。拒否の理由は
 * `BLOCKED_BY_GUARD` ではなく `GUARD_NOT_IMPLEMENTED` になるので、「条件を
 * 満たさなかった」と「まだ書いていない」は呼び出し側から区別できる。
 *
 * **いまは宣言されているガード（チケット 10・席 5）すべてに判定がある。** それでも
 * 上の扱いと数え上げ（`unimplementedTicketGuards()`）は残してある。ガードを足して
 * 判定を書き忘れたときに、そこが空でなくなることで気づけるためで、空であることは
 * `guards.test.ts` が見ている。
 */

import { candidatesFor, pickCandidate } from '../allocation/choose.js';
import { guidedTo } from '../allocation/needs-check.js';
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
 * チケットのガードの判定。
 *
 * **宣言されている 10 個すべてに判定がある。** 表（`ticket-machine.ts`）と
 * ここの鍵が一致していることは `guards.test.ts` が見ている。
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

  /**
   * 呼び出しを待たずに座ってよいか（7.8 の 4 行目、7.11 の 3 層目）。
   *
   * 7.8 の条件は「空席で、人数が収まり、**この席を待つ人が他にいない**」。
   * 最後の条件をそのまま「ほかに収まる人が 1 人もいない」と読むと、混んでいる
   * 施設では誰も前倒しできなくなる。狙いは 7.8 が括弧で書いている
   * 「待ち順序を崩さない」ことなので、**いまこの席に割り当てるとしたら自分が
   * 選ばれるか**で判定する。割当の選択（7.6）をそのまま使うので、前倒しで
   * 座っても順番は 1 つも動かない。
   *
   * **「確認要」の席にも同じ扉を開けてある。** 7.11 の 3 層目で案内された人が
   * 着いてみて空いていたときの道で、7.11 の「空いていれば着席の QR を」
   * 「着席されれば解消」がこれにあたる。案内を出す式（`suggestNeedsCheck`）と
   * ここが同じ関数を見ているので、**案内された本人だけが座れる。**
   */
  earlyCheckInAllowed: ({ ticket, state, table }) =>
    table !== null && table.enabled && seatIsOffered(state, ticket, table),

  /** 別の空席へ移ってよいか（7.8 の 2 行目）。 */
  swapAllowed: ({ state, ticket, table }) =>
    state.policy.allowTableSwap &&
    table !== null &&
    table.status === 'FREE' &&
    table.enabled &&
    fitsCapacity(table, ticket.partySize) &&
    satisfiesTags(table, ticket.requiredTags),

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
   * 着席時間の上限を、自動解放まで効かせる設定か（7.10）。
   *
   * `soft` と `hard` の違いはここだけ。席はどちらも「確認要」に落ちるが、
   * **チケットを終わらせるのは `hard` だけ**である。自動解放は物理的な退席を
   * 伴わないため、次の人を「まだ座っている席」に案内する事故を生む（7.10）。
   */
  hardLimitMode: ({ state }) => state.policy.timeLimitMode === 'hard',

  /**
   * 通知手段を持っていないか（7.9）。
   *
   * 「接続が切れてから何分たったか」はここでは見ない。**時間の経過は期限が
   * 表す**（`abandonedAt`）。ほかの時刻起因の遷移（ホールドの期限切れなど）も
   * 同じで、ガードは「どちらへ進むか」だけを決め、「いつ進むか」は期限が決める。
   */
  noNotificationChannel: ({ ticket }) => !ticket.hasNotificationChannel,
};

/** 席のガードの判定。**宣言されている 5 個すべてに判定がある。** */
const TABLE_GUARD_PREDICATES: Partial<
  Readonly<Record<TableGuard, (context: TableGuardContext) => boolean>>
> = {
  /** 対象外にする操作が保留されているか（7.6 のエッジケース）。 */
  disableAfterCurrent: ({ table }) => table.disableAfterCurrent,

  /** 対象外の予約が無く、引き続き管理対象か。`disableAfterCurrent` の裏返し。 */
  stillManaged: ({ table }) => !table.disableAfterCurrent,

  /**
   * 「確認要」の席を自動で空席に戻す設定か（7.11 の 5 層目）。
   *
   * `null` なら戻さない。**切るとスタッフが確認するまで席が塞がる。**
   */
  autoFreeEnabled: ({ state }) => state.policy.needsCheckAutoFreeMin !== null,

  /**
   * その席に、着席中のチケットが結びついたまま残っているか（7.11）。
   *
   * 「確認要」に落ちた席には 2 通りある。**誰が使っているか分からない席**
   * （無断利用が時間で落ちてきたもの）と、**着席の記録が残っている席**
   * （申告せずに去ったか、まだ座っているかが分からないもの）である。
   * 第三者から「使用中だった」と報告されたときの行き先が、これで変わる。
   */
  seatHasOccupant: ({ table }) => table.occupantTicketId !== null,

  /** 結びついたチケットが無いか。`seatHasOccupant` の裏返し。 */
  seatIsUnoccupied: ({ table }) => table.occupantTicketId === null,
};

/**
 * その席が、その人に差し出されているか。
 *
 * 空席なら通常の割当（7.6）で選ばれるかどうか、「確認要」なら 7.11 の 3 層目で
 * 案内されているかどうか。**どちらも「いま案内するなら誰か」を問うている。**
 */
function seatIsOffered(state: VenueState, ticket: Ticket, table: Table): boolean {
  if (table.status === 'FREE') {
    return pickCandidate(candidatesFor(table, state.tickets), table, state.policy)?.ticket.id === ticket.id;
  }
  return table.status === 'NEEDS_CHECK' && guidedTo(state, ticket.id, table.id);
}

/** そのガードの判定が書かれているか。 */
export function ticketGuardIsImplemented(guard: TicketGuard): boolean {
  return TICKET_GUARD_PREDICATES[guard] !== undefined;
}

/** そのガードの判定が書かれているか。 */
export function tableGuardIsImplemented(guard: TableGuard): boolean {
  return TABLE_GUARD_PREDICATES[guard] !== undefined;
}

/** 判定が書かれていないチケットのガード。**いまは空。** 書き忘れるとここに現れる。 */
export function unimplementedTicketGuards(): readonly TicketGuard[] {
  return TICKET_GUARDS.filter((guard) => !ticketGuardIsImplemented(guard));
}

/** 判定が書かれていない席のガード。**いまは空。** 書き忘れるとここに現れる。 */
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
