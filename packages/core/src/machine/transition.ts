/**
 * 遷移の段。遷移表とガードを突き合わせ、**行き先だけを返す**。
 *
 * ここが `apply` と `tick` の手順 2・3 にあたる。返すのは次の状態の名前だけで
 * 状態は作らないので、この関数を経由しても不変条件の検査を迂回できない。
 * PR 7 以降もすべての遷移をここに通すこと。
 *
 * `apply.ts` から分けてあるのは、割当の適用（`allocate.ts`）もこの段を使うためで、
 * 同じ場所に置くと `apply` と `allocate` が互いを読み合う形になる。
 */

import type { TableStatus } from '../domain/table.js';
import type { TicketState } from '../domain/ticket.js';
import { err, ok, type Result } from '../result.js';
import {
  evaluateTableGuard,
  evaluateTicketGuard,
  tableGuardIsImplemented,
  ticketGuardIsImplemented,
  type TableGuardContext,
  type TicketGuardContext,
} from './guards.js';
import { rejection, type Rejection } from './rejection.js';
import { TABLE_TRANSITIONS, type TableEvent } from './table-machine.js';
import { TICKET_TRANSITIONS, type TicketEvent } from './ticket-machine.js';
import { transit } from './transit.js';

/**
 * チケットに事象を起こしたときの行き先を求める。
 *
 * 文脈には操作の対象になっている席を含める。`fitsCapacity` のように
 * 「どの席に対してか」で答えが変わるガードがあるため。
 */
export function ticketTransition(
  context: TicketGuardContext,
  event: TicketEvent,
): Result<TicketState, Rejection> {
  const outcome = transit(TICKET_TRANSITIONS, context.ticket.state, event, (guard) =>
    evaluateTicketGuard(context, guard),
  );
  if (outcome.kind === 'moved') return ok(outcome.to);
  if (outcome.kind === 'undeclared') {
    return err(
      rejection('NOT_ALLOWED_IN_STATE', `${context.ticket.state} のチケットに ${event} は起こせない`),
    );
  }
  return err(blocked(outcome.tried, ticketGuardIsImplemented));
}

/** 席に事象を起こしたときの行き先を求める。 */
export function tableTransition(
  context: TableGuardContext,
  event: TableEvent,
): Result<TableStatus, Rejection> {
  const outcome = transit(TABLE_TRANSITIONS, context.table.status, event, (guard) =>
    evaluateTableGuard(context, guard),
  );
  if (outcome.kind === 'moved') return ok(outcome.to);
  if (outcome.kind === 'undeclared') {
    return err(rejection('NOT_ALLOWED_IN_STATE', `${context.table.status} の席に ${event} は起こせない`));
  }
  return err(blocked(outcome.tried, tableGuardIsImplemented));
}

/** 「条件を満たさなかった」と「判定がまだ書かれていない」を区別する。 */
function blocked<Guard extends string>(
  tried: readonly Guard[],
  isImplemented: (guard: Guard) => boolean,
): Rejection {
  const missing: readonly Guard[] = tried.filter((guard) => !isImplemented(guard));
  if (missing.length === tried.length) {
    return rejection('GUARD_NOT_IMPLEMENTED', `${missing.join('、')} の判定がまだ書かれていない`);
  }
  return rejection('BLOCKED_BY_GUARD', `${tried.join('、')} のいずれも成立しない`);
}
