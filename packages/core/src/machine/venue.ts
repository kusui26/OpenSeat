/**
 * 施設そのものの開閉（全体プラン 7.14、7.9）。
 *
 * **運用終了と全席解放は別の操作である**（7.4）。
 *
 * | | 待っている人 | 呼び出された人 | 着席中の人 | 席 |
 * |---|---|---|---|---|
 * | 運用終了 | 取り消す | **そのまま** | **そのまま** | 使っていない席だけ外す |
 * | 全席解放 | 取り消す | 取り消す | 終了（利用として扱う） | すべて外す |
 *
 * 運用終了で呼び出し中の人を残すのは、7.4 が「利用中の席（`HELD` を含む）は
 * 現在の利用が終わってから外す」としているためである。確保した席に向かって
 * いる人を締め出す理由が無い。到着すれば普通に利用が終わり、来なければ
 * ホールドの期限で片づく。
 *
 * **手続きは `apply`（手で閉じる）と `tick`（時間で閉じる）が共有する。** 2 か所に
 * 書くと、片方だけ直したときに静かにずれる。
 */

import { withTable, withTicket, type VenueState } from '../domain/state.js';
import { isActive, type EndReason, type Ticket } from '../domain/ticket.js';
import { leftService, type Table } from '../domain/table.js';
import { err, ok } from '../result.js';
import type { Timestamp } from '../time.js';
import type { CloseReason, DomainEvent } from './events.js';
import { rejection } from './rejection.js';
import { endedTicket } from './release.js';
import type { Outcome } from './settle.js';
import { CLOSE_APPLIES_TO } from './table-machine.js';
import { VENUE_CLOSE_APPLIES_TO } from './ticket-machine.js';
import { tableTransition, ticketTransition } from './transition.js';

// ---- 運用開始（全体プラン 7.14） ----

/**
 * 運用を始める。
 *
 * **管理対象の席（`enabled`）だけが戻る。** 管理者が対象から外した席は、運用が
 * 始まっても自由席のままである。`enabled`（対象席かどうか）と `DISABLED`
 * （いま運用から外れているか）は別のことを表している。
 */
export function openVenue(state: VenueState, closesAt: Timestamp | null, now: Timestamp): Outcome {
  if (state.operating) return err(rejection('NOT_ALLOWED_IN_STATE', 'すでに運用中である'));

  const opened = state.tables.filter((table) => table.enabled && table.status === 'DISABLED');
  const events: DomainEvent[] = [{ type: 'VenueOpened', at: now, closesAt }];
  let current: VenueState = state;

  for (const table of opened) {
    const moved = tableTransition({ state: current, table, now }, 'OPEN');
    if (!moved.ok) return err(moved.error);
    current = withTable(current, { ...table, status: moved.value, statusSince: now });
    events.push({ type: 'TableFreed', at: now, tableId: table.id, releasedTicketId: null });
  }
  return ok({ state: { ...current, operating: true, joinOpen: true, closesAt }, events });
}

// ---- 運用終了（全体プラン 7.14） ----

/**
 * 運用を終える。
 *
 * **`closesAt` は消さない。** 運用が終わったあとに待ちへ戻る人（ノーショーの
 * 繰り上げなど）を、次の `tick` で拾うためである（`deadlines.ts` の
 * `venueCloseAt`）。次の `OPEN` で置き換わる。
 */
export function closeVenue(state: VenueState, now: Timestamp, reason: CloseReason): Outcome {
  if (!state.operating) return err(rejection('NOT_ALLOWED_IN_STATE', '運用していない'));

  const cancelled = cancelWaiting(state, now);
  if (!cancelled.ok) return err(cancelled.error);

  const emptied = leaveService(cancelled.value.state, now);
  if (!emptied.ok) return err(emptied.error);

  return ok({
    state: { ...emptied.value.state, operating: false, joinOpen: false },
    events: [
      { type: 'VenueClosed', at: now, reason },
      ...cancelled.value.events,
      ...emptied.value.events,
    ],
  });
}

/** 待っている人を施設都合で取り消す。 */
function cancelWaiting(state: VenueState, now: Timestamp): Outcome {
  const waiting = state.tickets.filter((ticket) => VENUE_CLOSE_APPLIES_TO.includes(ticket.state));
  let current: VenueState = state;
  const events: DomainEvent[] = [];

  for (const ticket of waiting) {
    const ended = endForClose(current, ticket, now);
    if (!ended.ok) return err(ended.error);
    current = ended.value.state;
    events.push(...ended.value.events);
  }
  return ok({ state: current, events });
}

/** 1 枚のチケットを施設都合で取り消す。時間で閉じる道（`tick`）とも共有する。 */
export function endForClose(state: VenueState, ticket: Ticket, now: Timestamp): Outcome {
  const moved = ticketTransition({ state, ticket, now, table: null }, 'CLOSE');
  if (!moved.ok) return err(moved.error);
  return ok({
    state: withTicket(state, endedTicket(ticket, moved.value, 'venue_closed', now)),
    events: [ticketEnded(ticket.id, 'venue_closed', now)],
  });
}

/**
 * 使っていない席を運用から外す。
 *
 * **着席の記録が残っている「確認要」の席は外さない。** そこには `SEATED` の
 * チケットが結びついたままで（7.11、PR 10）、席だけ外すと席とチケットの対応が
 * 壊れる。その席は利用が終わってから外れる（`settle` が拾う）。
 */
function leaveService(state: VenueState, now: Timestamp): Outcome {
  const idle = state.tables.filter(
    (table) => CLOSE_APPLIES_TO.includes(table.status) && table.occupantTicketId === null,
  );
  let current: VenueState = state;
  const events: DomainEvent[] = [];

  for (const table of idle) {
    const moved = tableTransition({ state: current, table, now }, 'CLOSE');
    if (!moved.ok) return err(moved.error);
    // 外すと決めてあった席は、ここで本当に外れる（`leftService`）。運用終了で
    // 外れただけの席は対象席のままで、翌日の運用開始で戻る。
    current = withTable(current, leftService(table, moved.value, now));
    events.push({ type: 'TableDisabled', at: now, tableId: table.id });
  }
  return ok({ state: current, events });
}

// ---- 全席解放（全体プラン 7.9、12.6） ----

/**
 * すべてを自由席へ戻す。
 *
 * **この操作はいつでも動かなければならない**（CLAUDE.md 8 章）。障害時に掲示を
 * 出して自由席へ戻す手順が、システムの復旧より優先される。運用していない施設に
 * 対しても通る（席とチケットの後始末は残っているため）。
 *
 * 着席中の人は `DONE` になる。7.3 の図が「着席していた分は利用として扱う」と
 * しているためで、取り消し（`CANCELLED`）にはしない。
 */
export function releaseAll(state: VenueState, now: Timestamp): Outcome {
  const released = releaseTickets(state, now);
  if (!released.ok) return err(released.error);

  const emptied = releaseTables(released.value.state, now);
  if (!emptied.ok) return err(emptied.error);

  return ok({
    state: { ...emptied.value.state, operating: false, joinOpen: false, closesAt: null },
    events: [
      { type: 'VenueClosed', at: now, reason: 'release_all' },
      ...released.value.events,
      ...emptied.value.events,
    ],
  });
}

function releaseTickets(state: VenueState, now: Timestamp): Outcome {
  const living = state.tickets.filter((ticket) => isActive(ticket.state));
  let current: VenueState = state;
  const events: DomainEvent[] = [];

  for (const ticket of living) {
    const moved = ticketTransition({ state: current, ticket, now, table: null }, 'VENUE_RELEASE');
    if (!moved.ok) return err(moved.error);
    // 着席していた分は利用として扱うので、終わり方も退席と同じ側に置く。
    const reason: EndReason = moved.value === 'DONE' ? 'auto_release' : 'venue_closed';
    current = withTicket(current, endedTicket(ticket, moved.value, reason, now));
    events.push(ticketEnded(ticket.id, reason, now));
  }
  return ok({ state: current, events });
}

function releaseTables(state: VenueState, now: Timestamp): Outcome {
  const managed = state.tables.filter((table) => table.status !== 'DISABLED');
  let current: VenueState = state;
  const events: DomainEvent[] = [];

  for (const table of managed) {
    const moved = tableTransition({ state: current, table, now }, 'VENUE_RELEASE');
    if (!moved.ok) return err(moved.error);
    current = withTable(current, released(table, moved.value, now));
    events.push({ type: 'TableDisabled', at: now, tableId: table.id });
  }
  return ok({ state: current, events });
}

/**
 * 全席解放で外れる席。
 *
 * 誰も使っていない状態に戻すので、**外すと決めてあった席はここで本当に外れる**
 * （`leftService`）。着席の記録も消える。緊急の操作なので、席の側にやり残しを
 * 作らない。
 */
function released(table: Table, to: Table['status'], now: Timestamp): Table {
  return { ...leftService(table, to, now), occupantTicketId: null };
}

// ---- 共通 ----

function ticketEnded(ticketId: string, endReason: EndReason, now: Timestamp): DomainEvent {
  return { type: 'TicketEnded', at: now, ticketId, endReason, by: null, cancelReason: null };
}
