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

import type { Table } from '../domain/table.js';
import type { VenueState } from '../domain/state.js';
import type { Ticket } from '../domain/ticket.js';
import type { Timestamp } from '../time.js';
import { TICKET_GUARDS, type TicketGuard } from './ticket-machine.js';
import { TABLE_GUARDS, type TableGuard } from './table-machine.js';

/** チケットのガードが見てよいもの。施設全体の状態、対象のチケット、現在時刻。 */
export interface TicketGuardContext {
  readonly state: VenueState;
  readonly ticket: Ticket;
  readonly now: Timestamp;
}

/** テーブルのガードが見てよいもの。 */
export interface TableGuardContext {
  readonly state: VenueState;
  readonly table: Table;
  readonly now: Timestamp;
}

/**
 * 実装済みのチケットのガード。
 *
 * **この版（PR 5）は空である。** 受付・キャンセル・保留の遷移はすべて無条件で
 * 宣言されているため、判定すべきガードがまだ無い。PR 6（呼び出しとホールド）から
 * 埋まり始める。
 */
const TICKET_GUARD_PREDICATES: Partial<
  Readonly<Record<TicketGuard, (context: TicketGuardContext) => boolean>>
> = {};

/** 実装済みのテーブルのガード。こちらも PR 6 以降で埋まる。 */
const TABLE_GUARD_PREDICATES: Partial<
  Readonly<Record<TableGuard, (context: TableGuardContext) => boolean>>
> = {};

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

/** 判定がまだ書かれていないテーブルのガード。PR 12 で空になる。 */
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
