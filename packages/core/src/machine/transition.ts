/**
 * 遷移の段。遷移表とガードを突き合わせ、**行き先だけを返す**。
 *
 * ここが `apply` と `tick` の手順 2・3 にあたる。返すのは次の状態の名前だけで
 * 状態は作らないので、この関数を経由しても不変条件の検査を迂回できない。
 * **これから足す遷移も、すべてここに通すこと。**
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
import { TABLE_TRANSITIONS, type TableEvent, type TableTransition } from './table-machine.js';
import { TICKET_TRANSITIONS, type TicketEvent, type TicketTransition } from './ticket-machine.js';
import { taken, transit } from './transit.js';

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

/**
 * その文脈でその事象を起こすと、**遷移表のどの行が採られるか**。
 *
 * 採られる行が無ければ `null`（表に宣言が無いか、どのガードも通らない）。
 * 行き先だけでなく行そのものを返すので、**同じ（状態、事象、行き先）に複数の
 * 行があっても、どれが採られたかが分かる。**
 *
 * 宣言した遷移がすべて実際に採られうるか、を確かめるために公開している
 * （Phase 1 プラン PR 12 の「網羅性」）。振る舞いの側は `ticketTransition` を使う。
 */
export function ticketTransitionRow(
  context: TicketGuardContext,
  event: TicketEvent,
): TicketTransition | null {
  return taken(TICKET_TRANSITIONS, context.ticket.state, event, (guard) =>
    evaluateTicketGuard(context, guard),
  );
}

/** 席について同じことを答える。 */
export function tableTransitionRow(
  context: TableGuardContext,
  event: TableEvent,
): TableTransition | null {
  return taken(TABLE_TRANSITIONS, context.table.status, event, (guard) =>
    evaluateTableGuard(context, guard),
  );
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
