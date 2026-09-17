/**
 * 割当の適用。「誰をどの席へ」の決定（`allocation/choose.ts`）を状態に反映する。
 *
 * **`apply` と `tick` は、どちらも最後にこれを通る。** 割当を実行するきっかけは
 * 受付・準備OK・パス・取り消し・退席・設定変更・時刻の経過と多く（全体プラン 7.6）、
 * コマンドごとに呼び分けると必ずどれかを忘れる。忘れたときの症状は「空席がある
 * のに誰も呼ばれない」で、しかも次の操作で勝手に直るため気づきにくい。
 *
 * 毎回通しても無駄にはならない。噛み合う空席と待ちが無ければ
 * `chooseAssignments` は空を返し、状態は変わらない。
 *
 * この仕掛けのおかげで、`no_starvation`（収まる空席があるのに待ちが残らない）を
 * `apply` と `tick` の出口で検査できるようになる。PR 3 で「割当の直後にしか
 * 成立しない」として常時検査から外した条件が、ここで常時検査に戻る。
 */

import { chooseAssignments, type Assignment } from '../allocation/choose.js';
import { findTable, findTicket, withTable, withTicket, type VenueState } from '../domain/state.js';
import type { Table } from '../domain/table.js';
import type { Ticket, TicketState } from '../domain/ticket.js';
import type { TableId } from '../domain/ids.js';
import type { Decision } from '../decision.js';
import { err, ok, type Result } from '../result.js';
import type { Timestamp } from '../time.js';
import { holdDeadlineFor } from './deadlines.js';
import type { DomainEvent } from './events.js';
import { rejection, type Rejection } from './rejection.js';
import { tableTransition, ticketTransition } from './transition.js';

type Outcome = Result<Decision<VenueState, DomainEvent>, Rejection>;

/**
 * いま案内できる組をすべて呼び出す。
 *
 * 失敗するのは、選択（`chooseAssignments`）と遷移表・ガードが食い違ったときだけ
 * である。どちらも同じ `fitsCapacity` と `satisfiesTags` を見ているので起こらない。
 * それでも握り潰さず拒否として返す。起きたなら実装の誤りである。
 */
export function runAllocation(state: VenueState, now: Timestamp): Outcome {
  const assignments: readonly Assignment[] = chooseAssignments(state);
  const events: DomainEvent[] = [];
  let current: VenueState = state;

  for (const assignment of assignments) {
    const called = callOne(current, assignment, now);
    if (!called.ok) return err(called.error);
    current = called.value.state;
    events.push(...called.value.events);
  }
  return ok({ state: current, events });
}

/** 1 組を 1 つの席へ案内する。チケットは `CALLED`、席は `HELD` になる。 */
function callOne(state: VenueState, assignment: Assignment, now: Timestamp): Outcome {
  const ticket: Ticket | undefined = findTicket(state, assignment.ticketId);
  const table: Table | undefined = findTable(state, assignment.tableId);
  if (ticket === undefined || table === undefined) {
    return err(rejection('TICKET_NOT_FOUND', '選ばれた組か席が状態に無い'));
  }

  const movedTicket = ticketTransition({ state, ticket, now, table }, 'CALL');
  if (!movedTicket.ok) return err(movedTicket.error);
  const movedTable = tableTransition({ state, table, now }, 'HOLD');
  if (!movedTable.ok) return err(movedTable.error);

  const holdDeadline: Timestamp = holdDeadlineFor(state.policy, now);
  const held: Table = { ...table, status: movedTable.value, statusSince: now, occupantTicketId: ticket.id };
  const calling: Ticket = callingTicket(ticket, movedTicket.value, table.id, holdDeadline, now);
  return ok({
    state: withTicket(withTable(state, held), calling),
    events: callEvents(assignment, holdDeadline, now),
  });
}

/** 呼び出したことを、チケットの側と席の側の両方から記録する。 */
function callEvents(
  assignment: Assignment,
  holdDeadline: Timestamp,
  now: Timestamp,
): readonly DomainEvent[] {
  const { ticketId, tableId, reason } = assignment;
  return [
    { type: 'TicketCalled', at: now, ticketId, tableId, holdDeadline, reason },
    { type: 'TableHeld', at: now, tableId, heldForTicketId: ticketId },
  ];
}

/** 呼び出されたチケットの欄。 */
function callingTicket(
  ticket: Ticket,
  to: TicketState,
  tableId: TableId,
  holdDeadline: Timestamp,
  now: Timestamp,
): Ticket {
  return {
    ...ticket,
    state: to,
    tableId,
    calledAt: now,
    holdDeadline,
    holdRemindedAt: null,
    // 呼び出しごとに延長の回数を数え直す。「1 回の呼び出しにつき 1 回まで」と
    // 一文で説明できる（7.1）。譲ったあとの呼び出しでもう一度使える。
    extensions: 0,
    // 席が塞がっていた人の繰り上げ（7.8）は、席を案内した時点で果たされる。
    // 案内を受けたあとで自分から譲った人が、繰り上げを持ち続けることはない。
    conflictPriority: false,
  };
}
