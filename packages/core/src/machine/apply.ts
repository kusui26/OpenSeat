/**
 * コマンドの適用。**施設の状態が変わる唯一の入口**（`tick` を除く）。
 *
 * この骨格が、以降の PR で足されるすべてのコマンドに効く。`apply` は必ず
 * 次の手順を通る。
 *
 * 1. コマンドの前提条件を検査する（対象のチケットが存在するか、人数が正しいか）
 * 2. 遷移表を引く。表に無ければ拒否する
 * 3. ガードを評価する。満たさなければ拒否する
 * 4. 新しい状態を組み立てる（元の状態は変えない）
 * 5. **割当を実行する。** 空席と待ちが噛み合っていれば呼び出す（`allocate.ts`）
 * 6. **不変条件を検査する。破れていたら変更を破棄して拒否する**
 * 7. 起きたことをイベントとして返す
 *
 * **手順 5 と 6 を飛ばせないようにしてある。** 各コマンドの処理は module 内に
 * 閉じていて外から呼べず、`apply` だけが export されている。どの処理がどう状態を
 * 組み立てても、割当と出口の検査を通らずに `VenueState` が外へ出ることはない
 * （CLAUDE.md 3 章の判定基準）。
 *
 * 手順 2 を飛ばしていないことは、性質テストが押さえる。ランダムなコマンド列を
 * 流し、状態が変わったすべてのチケットについて、その（元の状態 → 次の状態）が
 * 遷移表に宣言されていることを確かめている。状態を直接書き換える処理を足せば
 * そこで落ちる。
 *
 * **前提**: `now` は呼び出しのたびに進む（戻らない）。サーバの時計だけを信頼する
 * という設計（全体プラン 9.4）に対応する。**この前提は入口で確かめる**ので、
 * 破ったまま静かに進むことはない（`clock.ts`）。
 */

import {
  allocateTicketCode,
  effectiveMaxPartySize,
  findTable,
  findTicket,
  queuedTickets,
  withTable,
  withTicket,
  type CodeAllocation,
  type VenueState,
} from '../domain/state.js';
import { createTicket, type EndReason, type Ticket, type TicketState } from '../domain/ticket.js';
import { fitsCapacity, type Table, type TableStatus } from '../domain/table.js';
import type { TableId, TicketCode, TicketId } from '../domain/ids.js';
import { err, ok, type Result } from '../result.js';
import { minutes, type Timestamp } from '../time.js';
import type { Decision } from '../decision.js';
import { checkClock } from './clock.js';
import { leaveService, reclaimSeat, settle, type Draft, type Outcome } from './settle.js';
import { closeVenue, openVenue, releaseAll } from './venue.js';
import {
  CANCEL_END_REASONS,
  CHECKOUT_END_REASONS,
  type Side,
  type CancelCommand,
  type CancelReason,
  type CheckInCommand,
  type CheckInEarlyCommand,
  type CheckOutCommand,
  type CloseCommand,
  type ConfirmFreeCommand,
  type DisableTableCommand,
  type EnableTableCommand,
  type OpenCommand,
  type ReleaseAllCommand,
  type ReportInUseCommand,
  type ReportTakenCommand,
  type StillHereCommand,
  type SwapTableCommand,
  type WalkInCommand,
  type ChangePartySizeCommand,
  type Command,
  type ExtendCommand,
  type HeartbeatCommand,
  type JoinCommand,
  type PassCommand,
  type PauseCommand,
  type ReadyCommand,
} from './command.js';
import { closedPause, extendedHoldDeadline, pauseDeadlineFor, startedPause } from './deadlines.js';
import type { DomainEvent, PauseReason } from './events.js';
import { rejection, type Rejection } from './rejection.js';
import { clearedHold, clearedHoldDeadline, endedTicket, releaseHeldTable } from './release.js';
import {
  CONFLICT_PRIORITY_APPLIES_TO,
  HEARTBEAT_APPLIES_TO,
  PARTY_SIZE_CHANGE_APPLIES_TO,
  TICKET_INITIAL_STATES,
  type TicketOrigin,
} from './ticket-machine.js';
import { tableTransition, ticketTransition } from './transition.js';

// ---- 手順 1: 共通の前提条件 ----

function requireTicket(state: VenueState, id: TicketId): Result<Ticket, Rejection> {
  const ticket: Ticket | undefined = findTicket(state, id);
  return ticket === undefined ? err(rejection('TICKET_NOT_FOUND', 'そのチケットは存在しない')) : ok(ticket);
}

/** 人数が受け付けられる範囲にあるか（全体プラン 7.5）。 */
function checkPartySize(state: VenueState, partySize: number): Rejection | null {
  if (!Number.isInteger(partySize)) return rejection('PARTY_SIZE_INVALID', '人数は整数であること');
  if (partySize < 1) return rejection('PARTY_TOO_SMALL', '人数は 1 以上であること');
  const max: number = effectiveMaxPartySize(state);
  if (partySize > max) {
    return rejection('PARTY_TOO_LARGE', `受け付けられる人数は ${max} まで（分割してご登録ください）`);
  }
  return null;
}

/** 状態を変えないコマンドが、いまのチケットの状態で受け付けられるか。 */
function checkAppliesTo(ticket: Ticket, states: readonly TicketState[], label: string): Rejection | null {
  return states.includes(ticket.state)
    ? null
    : rejection('NOT_ALLOWED_IN_STATE', `${ticket.state} のチケットに${label}は行えない`);
}

/** チケットが確保している席。持っていなければ null。 */
function tableOf(state: VenueState, ticket: Ticket): Table | null {
  return ticket.tableId === null ? null : (findTable(state, ticket.tableId) ?? null);
}

// ---- 受付（全体プラン 7.5） ----

/** 受付の検証。3 つの門（人数・受付の開閉・待ちの上限）をこの順に通す。 */
function checkJoin(state: VenueState, command: JoinCommand): Rejection | null {
  if (findTicket(state, command.ticketId) !== undefined) {
    return rejection('TICKET_ALREADY_EXISTS', 'その ID のチケットはすでにある');
  }
  const size: Rejection | null = checkPartySize(state, command.partySize);
  if (size !== null) return size;
  if (!state.joinOpen) return rejection('JOIN_CLOSED', '本日の受付は終了している');
  if (queuedTickets(state).length >= state.policy.maxQueueLength) {
    return rejection('QUEUE_FULL', `待ち行列が上限（${state.policy.maxQueueLength} 組）に達している`);
  }
  return null;
}

function handleJoin(state: VenueState, command: JoinCommand, now: Timestamp): Outcome {
  const problem: Rejection | null = checkJoin(state, command);
  if (problem !== null) return err(problem);

  const allocation = allocateTicketCode(state);
  if (allocation === null) return err(rejection('NO_CODE_AVAILABLE', '発行できる表示コードが残っていない'));

  const ticket: Ticket = newTicket(command, allocation.code, now);
  return ok({
    state: { ...state, tickets: [...state.tickets, ticket], nextCodeSeq: allocation.nextSeq },
    events: [joinedEvent(ticket, 'JOIN', now)],
  });
}

function newTicket(command: JoinCommand, code: TicketCode, now: Timestamp): Ticket {
  return createTicket({
    id: command.ticketId,
    code,
    partySize: command.partySize,
    now,
    requiredTags: command.requiredTags,
    hasNotificationChannel: command.hasNotificationChannel,
  });
}

// ---- 取り消し（全体プラン 7.9） ----

function handleCancel(state: VenueState, command: CancelCommand, now: Timestamp): Outcome {
  const found = requireTicket(state, command.ticketId);
  if (!found.ok) return err(found.error);
  const ticket: Ticket = found.value;

  if (command.by === 'staff' && command.reason === null) {
    return err(rejection('REASON_REQUIRED', 'スタッフの取り消しには理由が要る（監査のため）'));
  }
  const moved = ticketTransition({ state, ticket, now, table: tableOf(state, ticket) }, 'CANCEL');
  if (!moved.ok) return err(moved.error);

  const released = releaseHeldTable(state, ticket, now);
  if (!released.ok) return err(released.error);

  const endReason: EndReason = CANCEL_END_REASONS[command.by];
  return ok({
    state: withTicket(released.value.state, endedTicket(ticket, moved.value, endReason, now)),
    events: [ticketEnded(ticket.id, endReason, command.by, command.reason, now), ...released.value.events],
  });
}

/** チケットが終わったことを伝える。終わり方によらずこの 1 つで表す。 */
function ticketEnded(
  ticketId: TicketId,
  endReason: EndReason,
  by: Side,
  cancelReason: CancelReason | null,
  now: Timestamp,
): DomainEvent {
  return { type: 'TicketEnded', at: now, ticketId, endReason, by, cancelReason };
}

// ---- 保留・準備OK・パス（全体プラン 7.7 の 5〜7） ----

function handlePause(state: VenueState, command: PauseCommand, now: Timestamp): Outcome {
  const found = requireTicket(state, command.ticketId);
  if (!found.ok) return err(found.error);
  const ticket: Ticket = found.value;

  const moved = ticketTransition({ state, ticket, now, table: null }, 'PAUSE');
  if (!moved.ok) return err(moved.error);
  return ok(pausedDraft(state, ticket, moved.value, 'user_pause', now));
}

/**
 * 保留に入れる。
 *
 * 自分から保留にした場合、呼び出しを譲った場合、ホールドの期限が切れた場合の
 * 3 つで同じ形になる。違いは `reason` だけで、利用者への通知の文面と統計に使う。
 * `tick`（ノーショー）からも呼ぶ。
 */
export function pausedDraft(
  state: VenueState,
  ticket: Ticket,
  to: TicketState,
  reason: PauseReason,
  now: Timestamp,
): Draft {
  const started = startedPause(ticket, state.policy, now);
  const paused: Ticket = { ...ticket, ...clearedHold(), ...started, state: to };
  return {
    state: withTicket(state, paused),
    events: [
      { type: 'TicketPaused', at: now, ticketId: ticket.id, until: started.pauseDeadline, reason },
    ],
  };
}

/**
 * 呼び出しを次の人へ譲る（7.7 の 5）。
 *
 * 席は即座に空席へ戻る。**次の人への案内はここには書かない。** 手順 5 の割当が拾う。
 */
function handlePass(state: VenueState, command: PassCommand, now: Timestamp): Outcome {
  const found = requireTicket(state, command.ticketId);
  if (!found.ok) return err(found.error);
  const ticket: Ticket = found.value;

  const moved = ticketTransition({ state, ticket, now, table: tableOf(state, ticket) }, 'PASS');
  if (!moved.ok) return err(moved.error);

  const released = releaseHeldTable(state, ticket, now);
  if (!released.ok) return err(released.error);

  const passed: Ticket = { ...ticket, passes: ticket.passes + 1 };
  const draft = pausedDraft(released.value.state, passed, moved.value, 'passed', now);
  return ok({ state: draft.state, events: [...draft.events, ...released.value.events] });
}

function handleReady(state: VenueState, command: ReadyCommand, now: Timestamp): Outcome {
  const found = requireTicket(state, command.ticketId);
  if (!found.ok) return err(found.error);
  const ticket: Ticket = found.value;

  const moved = ticketTransition({ state, ticket, now, table: null }, 'READY');
  if (!moved.ok) return err(moved.error);

  // priorityAt には触れない。保留を挟んでも順番が変わらないことが、譲る動機を守る。
  const resumed: Ticket = { ...ticket, ...closedPause(ticket, now), state: moved.value };
  return ok({
    state: withTicket(state, resumed),
    events: [{ type: 'TicketResumed', at: now, ticketId: ticket.id }],
  });
}

// ---- 延長（全体プラン 7.7 の 4、7 の 7） ----

/**
 * 状態ごとの、延ばす期限。
 *
 * 遷移表には `CALLED → CALLED`（向かっています）と `PAUSED → PAUSED`
 * （まだ待っています）の 2 本がある。遷移が通った時点で状態はこのどちらかなので、
 * 分岐を書かずに対応表から引く。
 */
const EXTEND_BY_STATE: Partial<
  Readonly<Record<TicketState, (state: VenueState, ticket: Ticket, now: Timestamp) => Outcome>>
> = {
  CALLED: extendHold,
  PAUSED: extendPause,
};

function handleExtend(state: VenueState, command: ExtendCommand, now: Timestamp): Outcome {
  const found = requireTicket(state, command.ticketId);
  if (!found.ok) return err(found.error);
  const ticket: Ticket = found.value;

  const moved = ticketTransition({ state, ticket, now, table: tableOf(state, ticket) }, 'EXTEND');
  if (!moved.ok) return err(moved.error);

  const extend = EXTEND_BY_STATE[ticket.state];
  if (extend === undefined) {
    return err(rejection('NOT_ALLOWED_IN_STATE', `${ticket.state} には延ばせる期限が無い`));
  }
  return extend(state, ticket, now);
}

/** 「向かっています」。**期限から足す**（7.7 の図の「期限(7:00) ──[延長 +3]──> 期限(10:00)」）。 */
function extendHold(state: VenueState, ticket: Ticket, now: Timestamp): Outcome {
  const deadline: Timestamp | null = extendedHoldDeadline(ticket, state.policy);
  if (deadline === null) return err(rejection('NOT_ALLOWED_IN_STATE', '延ばせるホールドの期限が無い'));

  const extended: Ticket = {
    ...ticket,
    holdDeadline: deadline,
    extensions: ticket.extensions + 1,
    // 期限が **実際に動いたときだけ** 知らせの記録を消し、新しい期限について
    // もう一度知らせる。`holdExtensionMin` が 0 の施設では期限が動かないので、
    // 無条件に消すと同じ知らせを繰り返してしまう（1 つの期限につき 1 回）。
    holdRemindedAt: deadline > (ticket.holdDeadline ?? deadline) ? null : ticket.holdRemindedAt,
  };
  return ok({
    state: withTicket(state, extended),
    events: [{ type: 'TicketExtended', at: now, ticketId: ticket.id, from: 'CALLED', deadline }],
  });
}

/** 「まだ待っています」。**いまから数え直す。** 応答した時点が起点になる。 */
function extendPause(state: VenueState, ticket: Ticket, now: Timestamp): Outcome {
  const deadline: Timestamp = pauseDeadlineFor(ticket, state.policy, now);
  const extended: Ticket = { ...ticket, pauseDeadline: deadline };
  return ok({
    state: withTicket(state, extended),
    events: [{ type: 'TicketExtended', at: now, ticketId: ticket.id, from: 'PAUSED', deadline }],
  });
}

// ---- 着席と退席（全体プラン 7.8、7.11 の 1 層目） ----

/**
 * 着席の確認。
 *
 * 読み取った席が自分の席であることを `isAssignedTable` が見る。別の席を
 * 読んだ場合はここでは拒否する。「あなたの席は T-08 です」「この席に変更
 * しますか？」といった案内は座席 QR の分岐（PR 9）の責務である。
 */
function handleCheckIn(state: VenueState, command: CheckInCommand, now: Timestamp): Outcome {
  const found = requireTicket(state, command.ticketId);
  if (!found.ok) return err(found.error);
  const ticket: Ticket = found.value;

  const table: Table | undefined = findTable(state, command.tableId);
  if (table === undefined) return err(rejection('TABLE_NOT_FOUND', 'その席は存在しない'));

  const movedTicket = ticketTransition({ state, ticket, now, table }, 'CHECK_IN');
  if (!movedTicket.ok) return err(movedTicket.error);
  const movedTable = tableTransition({ state, table, now }, 'CHECK_IN');
  if (!movedTable.ok) return err(movedTable.error);

  // 席との結びつきは残す。外すのはホールドの期限だけ。
  return ok(seatedDraft(state, ticket, table, movedTicket.value, movedTable.value, now));
}

/**
 * 退席の申告。
 *
 * 席は片付けの猶予（`TURNOVER`）に入る。**猶予が明けるのを待つのは `tick` の
 * 責務**で、既定の 0 分なら同じ処理のうちに明ける。
 *
 * `verifiedFreeAt` をここで更新する。「席が空いている」ことの手がかりとして、
 * 本人の申告がもっとも新しい証拠になる（7.6 の席の並び順）。
 */
function handleCheckOut(state: VenueState, command: CheckOutCommand, now: Timestamp): Outcome {
  const found = requireTicket(state, command.ticketId);
  if (!found.ok) return err(found.error);
  const ticket: Ticket = found.value;

  const movedTicket = ticketTransition({ state, ticket, now, table: null }, 'CHECK_OUT');
  if (!movedTicket.ok) return err(movedTicket.error);

  const vacated = vacateTable(state, ticket, now);
  if (!vacated.ok) return err(vacated.error);

  const endReason: EndReason = CHECKOUT_END_REASONS[command.by];
  return ok({
    state: withTicket(vacated.value.state, endedTicket(ticket, movedTicket.value, endReason, now)),
    events: [ticketEnded(ticket.id, endReason, command.by, null, now), ...vacated.value.events],
  });
}

/** 使い終わった席を片付けの猶予へ送る。 */
function vacateTable(state: VenueState, ticket: Ticket, now: Timestamp): Outcome {
  const table: Table | null = tableOf(state, ticket);
  if (table === null) return err(rejection('TABLE_NOT_FOUND', '着席中のチケットに席が無い'));

  const moved = tableTransition({ state, table, now }, 'CHECK_OUT');
  if (!moved.ok) return err(moved.error);

  const freeAt: Timestamp = now + minutes(state.policy.turnoverMin);
  const cleaning: Table = {
    ...table,
    status: moved.value,
    statusSince: now,
    occupantTicketId: null,
    verifiedFreeAt: now,
  };
  return ok({
    state: withTable(state, cleaning),
    events: [
      { type: 'TableVacated', at: now, tableId: table.id, vacatedByTicketId: ticket.id, freeAt },
    ],
  });
}

// ---- 座席 QR の分岐（全体プラン 7.8、7.12、7.11 の 3 層目） ----

/**
 * 案内する席を変える（7.8 の 2 行目）。
 *
 * 呼び出しは続いたまま、席だけが移る。**期限は動かさない。** すでに新しい席の
 * 前に立っている人が、さらに時間を得る理由が無いためである。
 */
function handleSwapTable(state: VenueState, command: SwapTableCommand, now: Timestamp): Outcome {
  const found = requireCalledAt(state, command.ticketId, command.tableId);
  if (!found.ok) return err(found.error);
  const { ticket, table } = found.value;

  const moved = ticketTransition({ state, ticket, now, table }, 'SWAP_TABLE');
  if (!moved.ok) return err(moved.error);
  const held = tableTransition({ state, table, now }, 'HOLD');
  if (!held.ok) return err(held.error);

  const released = releaseHeldTable(state, ticket, now);
  if (!released.ok) return err(released.error);

  const next: Table = { ...table, status: held.value, statusSince: now, occupantTicketId: ticket.id };
  const swapped: Ticket = { ...ticket, state: moved.value, tableId: table.id };
  return ok({
    state: withTicket(withTable(released.value.state, next), swapped),
    events: [...swappedEvents(ticket, table.id, now), ...released.value.events],
  });
}

/** 席を移したことを、移り先と移り元の両方から記録する（移り元は呼び出し側）。 */
function swappedEvents(ticket: Ticket, toTableId: TableId, now: Timestamp): readonly DomainEvent[] {
  return [
    {
      type: 'TicketSwapped',
      at: now,
      ticketId: ticket.id,
      fromTableId: ticket.tableId ?? toTableId,
      toTableId,
    },
    { type: 'TableHeld', at: now, tableId: toTableId, heldForTicketId: ticket.id },
  ];
}

/**
 * 呼び出しを待たずに座る（7.8 の 4 行目、7.11 の 3 層目）。
 *
 * **待ち順序を崩さない条件つき。** その席にいま割り当てるとしたら自分が選ばれる
 * 場合だけ通る（`earlyCheckInAllowed`）。
 *
 * 「確認要」の席もここを通る。7.11 の 3 層目で案内された人が、着いてみて空いて
 * いたときの道である。**前の利用者の記録が残っていれば、その人は申告せずに
 * 去ったものとして終わらせる。** そうしないと 1 つの席に 2 枚のチケットが残る。
 */
function handleCheckInEarly(state: VenueState, command: CheckInEarlyCommand, now: Timestamp): Outcome {
  const found = requireTicketAndTable(state, command.ticketId, command.tableId);
  if (!found.ok) return err(found.error);
  const { ticket, table } = found.value;

  const moved = ticketTransition({ state, ticket, now, table }, 'CHECK_IN_EARLY');
  if (!moved.ok) return err(moved.error);
  const occupied = tableTransition({ state, table, now }, 'CHECK_IN_EARLY');
  if (!occupied.ok) return err(occupied.error);

  const cleared = reclaimSeat(state, table.occupantTicketId, now);
  if (!cleared.ok) return err(cleared.error);
  const seated = seatedDraft(cleared.value.state, ticket, table, moved.value, occupied.value, now);
  return ok({ state: seated.state, events: [...cleared.value.events, ...seated.events] });
}

/**
 * 飛び込み着席（7.12、7.8 の 6 行目）。
 *
 * 待ち行列を経ずにチケットを作り、いきなり着席させる。
 *
 * **受付の開閉は見ない。** 受付を閉じたあとでも、その席が使われていることを
 * 記録できるほうが状態は正確になる（7.12 の (a)）。待ち行列にも入らないので
 * `maxQueueLength` にも触れない。
 */
function handleWalkIn(state: VenueState, command: WalkInCommand, now: Timestamp): Outcome {
  if (findTicket(state, command.ticketId) !== undefined) {
    return err(rejection('TICKET_ALREADY_EXISTS', 'その ID のチケットはすでにある'));
  }
  const table: Table | undefined = findTable(state, command.tableId);
  if (table === undefined) return err(rejection('TABLE_NOT_FOUND', 'その席は存在しない'));

  const problem: Rejection | null = checkWalkInSize(table, command.partySize);
  if (problem !== null) return err(problem);

  const allocation = allocateTicketCode(state);
  if (allocation === null) return err(rejection('NO_CODE_AVAILABLE', '発行できる表示コードが残っていない'));

  const occupied = tableTransition({ state, table, now }, 'WALK_IN');
  if (!occupied.ok) return err(occupied.error);
  return ok(walkInDraft(state, command, allocation, table, occupied.value, now));
}

/** 飛び込みの人数。**その席の定員だけを見る**（施設全体の上限ではない）。 */
function checkWalkInSize(table: Table, partySize: number): Rejection | null {
  if (!Number.isInteger(partySize)) return rejection('PARTY_SIZE_INVALID', '人数は整数であること');
  if (partySize < 1) return rejection('PARTY_TOO_SMALL', '人数は 1 以上であること');
  if (!fitsCapacity(table, partySize)) {
    return rejection('PARTY_TOO_LARGE', `この席は ${table.capacity} 名まで（受付でご登録ください）`);
  }
  return null;
}

function walkInDraft(
  state: VenueState,
  command: WalkInCommand,
  allocation: CodeAllocation,
  table: Table,
  to: TableStatus,
  now: Timestamp,
): Draft {
  const ticket: Ticket = walkInTicket(command, allocation.code, table.id, now);
  const occupied: Table = { ...table, status: to, statusSince: now, occupantTicketId: ticket.id };
  const seated: VenueState = {
    ...withTable(state, occupied),
    tickets: [...state.tickets, ticket],
    nextCodeSeq: allocation.nextSeq,
  };
  return {
    state: seated,
    events: [joinedEvent(ticket, 'WALK_IN', now), ...seatedEvents(ticket.id, table.id, now)],
  };
}

/** 飛び込みのチケット。待ち行列を経ないので、いきなり着席から始まる。 */
function walkInTicket(
  command: WalkInCommand,
  code: TicketCode,
  tableId: TableId,
  now: Timestamp,
): Ticket {
  return {
    ...createTicket({ id: command.ticketId, code, partySize: command.partySize, now }),
    state: TICKET_INITIAL_STATES.WALK_IN,
    tableId,
    seatedAt: now,
  };
}

/** チケットが作られたことを伝える。受付からでも飛び込みでも同じ形。 */
function joinedEvent(ticket: Ticket, origin: TicketOrigin, now: Timestamp): DomainEvent {
  return {
    type: 'TicketJoined',
    at: now,
    ticketId: ticket.id,
    code: ticket.code,
    partySize: ticket.partySize,
    origin,
  };
}

/**
 * 案内された席に誰かが座っていた（7.8 の 10 行目）。
 *
 * 席は「誰かが使っているが誰かは分からない」に落とし、本人は待ちに戻す。
 * **受付時刻はそのまま**で、さらに同時刻の他者より前に出す。案内した側の
 * 落ち度なので、順番で埋め合わせる。
 */
function handleReportTaken(state: VenueState, command: ReportTakenCommand, now: Timestamp): Outcome {
  const found = requireCalledAt(state, command.ticketId, command.tableId);
  if (!found.ok) return err(found.error);
  const { ticket, table } = found.value;
  if (ticket.tableId !== table.id) {
    return err(rejection('NOT_ALLOWED_IN_STATE', '自分に案内された席ではない'));
  }

  const moved = ticketTransition({ state, ticket, now, table }, 'REPORT_TAKEN');
  if (!moved.ok) return err(moved.error);
  const taken = tableTransition({ state, table, now }, 'REPORT_TAKEN');
  if (!taken.ok) return err(taken.error);

  const occupied: Table = { ...table, status: taken.value, statusSince: now, occupantTicketId: null };
  const requeued: Ticket = { ...ticket, ...clearedHold(), state: moved.value, conflictPriority: true };
  return ok({
    state: withTicket(withTable(state, occupied), requeued),
    events: reportedInUseEvents(ticket, table.id, now),
  });
}

/** 使用中だと報告されたことと、報告した人の繰り上げ。 */
function reportedInUseEvents(ticket: Ticket, tableId: TableId, now: Timestamp): readonly DomainEvent[] {
  return [
    { type: 'TableReportedInUse', at: now, tableId, reportedByTicketId: ticket.id },
    requeuedEvent(ticket.id, ticket.priorityAt, 'seat_taken', now),
  ];
}

/**
 * この席は使用中だ、という報告（7.11 の 3 層目）。
 *
 * 「空いている可能性が高い席」に案内された人が押す「使用中」。報告した人が
 * 待っている人なら、席が塞がっていた人と同じ埋め合わせ（繰り上げ）を受ける。
 * 第三者やスタッフの報告では席だけが動く。
 */
function handleReportInUse(state: VenueState, command: ReportInUseCommand, now: Timestamp): Outcome {
  const table: Table | undefined = findTable(state, command.tableId);
  if (table === undefined) return err(rejection('TABLE_NOT_FOUND', 'その席は存在しない'));

  const moved = tableTransition({ state, table, now }, 'REPORT_IN_USE');
  if (!moved.ok) return err(moved.error);

  const settled = settleReportedTable(state, table, moved.value, now);
  if (!settled.ok) return err(settled.error);

  const reporter = command.ticketId === null ? null : findTicket(settled.value.state, command.ticketId);
  const events: DomainEvent[] = [
    { type: 'TableReportedInUse', at: now, tableId: table.id, reportedByTicketId: reporter?.id ?? null },
    ...settled.value.events,
  ];
  if (reporter === undefined) return err(rejection('TICKET_NOT_FOUND', 'そのチケットは存在しない'));
  if (reporter === null) return ok({ state: settled.value.state, events });

  const allowed: Rejection | null = checkAppliesTo(reporter, CONFLICT_PRIORITY_APPLIES_TO, '使用中の報告');
  if (allowed !== null) return err(allowed);
  const prioritised: Ticket = { ...reporter, conflictPriority: true };
  events.push(requeuedEvent(reporter.id, reporter.priorityAt, 'seat_taken', now));
  return ok({ state: withTicket(settled.value.state, prioritised), events });
}

/**
 * 「使用中」と報告された席を書き換える。
 *
 * 行き先は遷移表が決めている（`seatHasOccupant`）。着席の記録が残っている席なら
 * `OCCUPIED` に戻り、**その記録の人が居たと分かる**。誰の記録も無ければ
 * `OCCUPIED_UNKNOWN`。
 *
 * 記録の人に戻すときは、**問いかけ（7.11 の 2 層目）の決着もここでつける。**
 * 本人は答えていないが、第三者が「使われている」と見たことは答えと同じ重みの
 * 事実である。決着をつけないと、無応答の期限が過ぎたままなので、次の `tick` で
 * すぐまた「確認要」に落ちて同じことを繰り返す。
 */
function settleReportedTable(
  state: VenueState,
  table: Table,
  to: TableStatus,
  now: Timestamp,
): Outcome {
  const keepsOccupant: boolean = to === 'OCCUPIED';
  const next: Table = {
    ...table,
    status: to,
    statusSince: now,
    occupantTicketId: keepsOccupant ? table.occupantTicketId : null,
  };
  const withNext: VenueState = withTable(state, next);
  return keepsOccupant ? confirmOccupant(withNext, next, now) : ok({ state: withNext, events: [] });
}

/** その席に残っていた人が、居ると分かった。問いかけの決着をここでつける。 */
function confirmOccupant(state: VenueState, table: Table, now: Timestamp): Outcome {
  const occupant: Ticket | undefined =
    table.occupantTicketId === null ? undefined : findTicket(state, table.occupantTicketId);
  if (occupant === undefined) return ok({ state, events: [] });

  return ok({
    state: withTicket(state, { ...occupant, stillHereAnsweredAt: now }),
    events: [{ type: 'TableOccupied', at: now, tableId: table.id, occupantTicketId: occupant.id }],
  });
}

/**
 * この席は空いている、という報告（7.8 の 9 行目、7.11 の 3〜4 層目）。
 *
 * 誰が座っているか分かっている席（`OCCUPIED`）には遷移が宣言されていないので、
 * 第三者が着席中の人を追い出すことはできない。**「確認要」に落ちた席だけが、
 * 着席の記録を持ったまま空席に戻りうる。** そこまで落ちた席は、システムの側が
 * すでに「その人が居るか分からない」と認めた席である。
 *
 * **ただし、その記録を消せるのはスタッフだけ**（`checkWhoMayFree`）。
 */
function handleConfirmFree(state: VenueState, command: ConfirmFreeCommand, now: Timestamp): Outcome {
  const table: Table | undefined = findTable(state, command.tableId);
  if (table === undefined) return err(rejection('TABLE_NOT_FOUND', 'その席は存在しない'));

  const moved = tableTransition({ state, table, now }, 'CONFIRM_FREE');
  if (!moved.ok) return err(moved.error);

  // **遷移を引いたあとに見る。** 着席中の席のように誰も空席に戻せない席では
  // 「表に無い」が正しい理由で、スタッフなら通るかのような拒否を返さない。
  const allowed: Rejection | null = checkWhoMayFree(table, command.by);
  if (allowed !== null) return err(allowed);

  // 着席の記録が残ったままなら、その人は申告せずに去っている（7.11）。
  const cleared = reclaimSeat(withTable(state, verifiedFree(table, moved.value, now)), table.occupantTicketId, now);
  if (!cleared.ok) return err(cleared.error);
  return ok({
    state: cleared.value.state,
    events: [
      { type: 'TableFreed', at: now, tableId: table.id, releasedTicketId: null },
      ...cleared.value.events,
    ],
  });
}

/**
 * その席を空席に戻してよい人か（全体プラン 7.11 の 3 層目、7.15）。
 *
 * **着席の記録が残っている席を空席に戻せるのは、スタッフだけである。** この操作は
 * 記録の人のチケットを終わらせるので（`reclaimSeat`）、通りすがりの人の一押しで
 * 他人の順番が消えることになってしまう。利用者に厳しくしない（CLAUDE.md 2.5）。
 *
 * **記録の無い席は、これまでどおり誰でも空席に戻せる。** 誰が使っているか分からない
 * 席や、無断利用が時間で落ちてきた席がこれにあたる。終わるチケットが無いので、
 * 誤っていても次に案内された人が「使用中でした」と報告すれば戻るだけである。
 * 7.11 の 3 層目が速さで効いているのはこちらなので、狭めない。
 *
 * 案内された本人は、この操作を使わずに **座ること**（`CHECK_IN_EARLY`）で同じ場面を
 * 解消できる。確かめに行った人がその席を得る、という 7.11 の筋はそのまま保たれる。
 *
 * **`by` がスタッフであることの確認は境界側の責務である**（Phase 2 の権限表）。
 * `core` はコマンドに書かれた実行者を信じる。取り消しや退席の申告と同じ扱い。
 */
function checkWhoMayFree(table: Table, by: Side): Rejection | null {
  if (table.occupantTicketId === null || by === 'staff') return null;
  return rejection('STAFF_ONLY', '着席の記録が残っている席を空席に戻せるのはスタッフだけ');
}

/** 人が見て空だと確かめた席。席の並び順で、いちばん確からしい空席になる（7.6）。 */
function verifiedFree(table: Table, to: TableStatus, now: Timestamp): Table {
  return { ...table, status: to, statusSince: now, occupantTicketId: null, verifiedFreeAt: now };
}

function requeuedEvent(
  ticketId: TicketId,
  priorityAt: Timestamp,
  reason: 'no_show' | 'seat_taken',
  now: Timestamp,
): DomainEvent {
  return { type: 'TicketRequeued', at: now, ticketId, priorityAt, reason };
}

/** 着席した状態の下書き。前倒しの着席と、呼び出しからの着席で共通。 */
function seatedDraft(
  state: VenueState,
  ticket: Ticket,
  table: Table,
  to: TicketState,
  tableTo: TableStatus,
  now: Timestamp,
): Draft {
  const seated: Ticket = { ...ticket, ...clearedHoldDeadline(), state: to, tableId: table.id, seatedAt: now };
  const occupied: Table = { ...table, status: tableTo, statusSince: now, occupantTicketId: ticket.id };
  return {
    state: withTicket(withTable(state, occupied), seated),
    events: seatedEvents(ticket.id, table.id, now),
  };
}

/** 着席したことを、チケットの側と席の側の両方から記録する。 */
function seatedEvents(ticketId: TicketId, tableId: TableId, now: Timestamp): readonly DomainEvent[] {
  return [
    { type: 'TicketSeated', at: now, ticketId, tableId },
    { type: 'TableOccupied', at: now, tableId, occupantTicketId: ticketId },
  ];
}

interface TicketAndTable {
  readonly ticket: Ticket;
  readonly table: Table;
}

function requireTicketAndTable(
  state: VenueState,
  ticketId: TicketId,
  tableId: TableId,
): Result<TicketAndTable, Rejection> {
  const found = requireTicket(state, ticketId);
  if (!found.ok) return err(found.error);
  const table: Table | undefined = findTable(state, tableId);
  if (table === undefined) return err(rejection('TABLE_NOT_FOUND', 'その席は存在しない'));
  return ok({ ticket: found.value, table });
}

/** 呼び出し中の人と、読み取った席。 */
function requireCalledAt(
  state: VenueState,
  ticketId: TicketId,
  tableId: TableId,
): Result<TicketAndTable, Rejection> {
  return requireTicketAndTable(state, ticketId, tableId);
}

// ---- 「まだご利用中です」（全体プラン 7.11 の 2 層目） ----

/**
 * 問いかけへの答え。
 *
 * **答えたことを記録するだけで、利用は続く。** 席がすでに「確認要」に落ちて
 * いれば使用中に戻す。落ちる前に答えれば、席は動かない（`OCCUPIED` のまま）。
 */
function handleStillHere(state: VenueState, command: StillHereCommand, now: Timestamp): Outcome {
  const found = requireTicket(state, command.ticketId);
  if (!found.ok) return err(found.error);
  const ticket: Ticket = found.value;

  const table: Table | null = tableOf(state, ticket);
  const moved = ticketTransition({ state, ticket, now, table }, 'STILL_HERE');
  if (!moved.ok) return err(moved.error);
  if (table === null) return err(rejection('TABLE_NOT_FOUND', '着席中のチケットに席が無い'));

  const answered: Ticket = { ...ticket, state: moved.value, stillHereAnsweredAt: now };
  const restored = restoreTable(state, table, now);
  if (!restored.ok) return err(restored.error);

  return ok({
    state: withTicket(restored.value.state, answered),
    events: [
      { type: 'StillHereAnswered', at: now, ticketId: ticket.id, tableId: table.id },
      ...restored.value.events,
    ],
  });
}

/** 「確認要」に落ちていた席を、使用中に戻す。落ちていなければ何もしない。 */
function restoreTable(state: VenueState, table: Table, now: Timestamp): Outcome {
  if (table.status !== 'NEEDS_CHECK') return ok({ state, events: [] });

  const moved = tableTransition({ state, table, now }, 'STILL_HERE');
  if (!moved.ok) return err(moved.error);
  const occupied: Table = { ...table, status: moved.value, statusSince: now };
  return ok({
    state: withTable(state, occupied),
    events: [
      { type: 'TableOccupied', at: now, tableId: table.id, occupantTicketId: table.occupantTicketId ?? '' },
    ],
  });
}

// ---- 人数の変更（全体プラン 7.6 のエッジケース） ----

function handleChangePartySize(state: VenueState, command: ChangePartySizeCommand, now: Timestamp): Outcome {
  const found = requireTicket(state, command.ticketId);
  if (!found.ok) return err(found.error);
  const ticket: Ticket = found.value;

  const problem: Rejection | null =
    checkAppliesTo(ticket, PARTY_SIZE_CHANGE_APPLIES_TO, '人数の変更') ??
    checkPartySize(state, command.partySize);
  if (problem !== null) return err(problem);
  if (command.partySize === ticket.partySize) return ok({ state, events: [] });

  // 増やしたときだけ順番をやり直す。「1 名で登録して 4 名に変える」抜け道を防ぐ。
  const priorityAt: Timestamp = command.partySize > ticket.partySize ? now : ticket.priorityAt;
  const changed: Ticket = { ...ticket, partySize: command.partySize, priorityAt };
  return ok({ state: withTicket(state, changed), events: [resized(ticket, changed, now)] });
}

function resized(before: Ticket, after: Ticket, now: Timestamp): DomainEvent {
  return {
    type: 'PartySizeChanged',
    at: now,
    ticketId: after.id,
    from: before.partySize,
    to: after.partySize,
    priorityAt: after.priorityAt,
  };
}

// ---- 心拍（全体プラン 7.9 の「暗黙のキャンセル」） ----

/**
 * 画面が開いていることの通知。
 *
 * **イベントを出さない。** 数秒ごとに届くため、永続化すれば意味の無い行で
 * 埋まる。放置の判定に要るのは最後の時刻だけで、それは状態が持っている。
 */
function handleHeartbeat(state: VenueState, command: HeartbeatCommand, now: Timestamp): Outcome {
  const found = requireTicket(state, command.ticketId);
  if (!found.ok) return err(found.error);
  const ticket: Ticket = found.value;

  const allowed: Rejection | null = checkAppliesTo(ticket, HEARTBEAT_APPLIES_TO, '心拍の記録');
  if (allowed !== null) return err(allowed);
  return ok({ state: withTicket(state, { ...ticket, lastSeenAt: now }), events: [] });
}

// ---- 施設の開閉（全体プラン 7.14、7.9） ----

/**
 * 運用を始める（7.14）。
 *
 * スケジュールによる開始も、スタッフの手動 ON も同じコマンドで表す。**どちらを
 * 優先するかは呼ぶ側の判断**で、7.14 の「スタッフの手動 ON/OFF を優先させる」は
 * 境界側のスケジューラが手動の指示を上書きしない、という形で実現する。
 */
function handleOpen(state: VenueState, command: OpenCommand, now: Timestamp): Outcome {
  return openVenue(state, command.closesAt, now);
}

/** 運用を終える（7.14）。時間で終わる場合は `tick` が同じ手続きを踏む。 */
function handleClose(state: VenueState, _command: CloseCommand, now: Timestamp): Outcome {
  return closeVenue(state, now, 'manual');
}

/** 全席解放（7.9、12.6）。**運用していなくても通る。** */
function handleReleaseAll(state: VenueState, _command: ReleaseAllCommand, now: Timestamp): Outcome {
  return releaseAll(state, now);
}

// ---- 席の設定変更（全体プラン 7.6 のエッジケース） ----

/**
 * 席を対象から外す。
 *
 * **使われていない席はその場で外れる。使われている席は利用が終わってから外れる**
 * （`disableAfterCurrent`）。呼び出し中の人を追い出さないための順序である。
 *
 * 使われていない席とは、空席（`FREE`）と、すでに運用から外れている席
 * （`DISABLED`。運用時間外や、前日の終了で外れたまま）である。**後者を待たせない。**
 * 誰も使っていないのに予約のまま置くと、翌日の運用開始で一度空席として戻り、
 * すぐまた外れる。画面には一瞬「空きました」と出て消える。
 *
 * 空席をその場で外すのは、時刻を正しく刻むためでもある。出口（`settle`）に
 * 任せると「空いた時刻」で外れてしまい、**外すと決めるより前の時刻**が
 * イベントに載る。
 */
function handleDisableTable(state: VenueState, command: DisableTableCommand, now: Timestamp): Outcome {
  const table: Table | undefined = findTable(state, command.tableId);
  if (table === undefined) return err(rejection('TABLE_NOT_FOUND', 'その席は存在しない'));

  // すでに運用から外れている席。状態は動かないので遷移もイベントも無く、
  // 管理対象から外すだけになる（`ENABLE_TABLE` の裏返し）。
  if (table.status === 'DISABLED') {
    const excluded: Table = { ...table, enabled: false, disableAfterCurrent: false };
    return ok({ state: withTable(state, excluded), events: [] });
  }

  const reserved: Table = { ...table, disableAfterCurrent: true };
  if (reserved.status !== 'FREE') return ok({ state: withTable(state, reserved), events: [] });
  return leaveService(withTable(state, reserved), reserved, now);
}

/**
 * 席を対象に戻す。
 *
 * 外れるのを待っている予約も取り消す。運用中なら、その場で空席として使える
 * ようになる。**外す操作と対にしてある**（片道だけ用意すると、誤って外した席を
 * 戻す手段が無くなる）。
 */
function handleEnableTable(state: VenueState, command: EnableTableCommand, now: Timestamp): Outcome {
  const table: Table | undefined = findTable(state, command.tableId);
  if (table === undefined) return err(rejection('TABLE_NOT_FOUND', 'その席は存在しない'));

  const managed: Table = { ...table, enabled: true, disableAfterCurrent: false };
  if (!state.operating || managed.status !== 'DISABLED') {
    return ok({ state: withTable(state, managed), events: [] });
  }
  const moved = tableTransition({ state, table: managed, now }, 'OPEN');
  if (!moved.ok) return err(moved.error);
  return ok({
    state: withTable(state, { ...managed, status: moved.value, statusSince: now }),
    events: [{ type: 'TableFreed', at: now, tableId: table.id, releasedTicketId: null }],
  });
}

// ---- 入口 ----

/**
 * コマンドを担当する処理へ振り分ける（手順 1〜4）。
 *
 * 種別ごとに 1 行ずつ並べるだけの分岐で、絡んだ条件は無い。分岐の数がそのまま
 * 複雑度と行数として数えられるが、分けても読みやすくならないのでこの関数だけ
 * 外す。書き忘れは `switch-exhaustiveness-check` が捕まえる（型で守られている）。
 */
// eslint-disable-next-line complexity, max-lines-per-function
function route(state: VenueState, command: Command, now: Timestamp): Outcome {
  switch (command.type) {
    case 'JOIN': return handleJoin(state, command, now);
    case 'CANCEL': return handleCancel(state, command, now);
    case 'PAUSE': return handlePause(state, command, now);
    case 'READY': return handleReady(state, command, now);
    case 'EXTEND': return handleExtend(state, command, now);
    case 'PASS': return handlePass(state, command, now);
    case 'CHECK_IN': return handleCheckIn(state, command, now);
    case 'CHECK_OUT': return handleCheckOut(state, command, now);
    case 'SWAP_TABLE': return handleSwapTable(state, command, now);
    case 'CHECK_IN_EARLY': return handleCheckInEarly(state, command, now);
    case 'WALK_IN': return handleWalkIn(state, command, now);
    case 'REPORT_TAKEN': return handleReportTaken(state, command, now);
    case 'REPORT_IN_USE': return handleReportInUse(state, command, now);
    case 'CONFIRM_FREE': return handleConfirmFree(state, command, now);
    case 'STILL_HERE': return handleStillHere(state, command, now);
    case 'CHANGE_PARTY_SIZE': return handleChangePartySize(state, command, now);
    case 'HEARTBEAT': return handleHeartbeat(state, command, now);
    case 'OPEN': return handleOpen(state, command, now);
    case 'CLOSE': return handleClose(state, command, now);
    case 'RELEASE_ALL': return handleReleaseAll(state, command, now);
    case 'DISABLE_TABLE': return handleDisableTable(state, command, now);
    case 'ENABLE_TABLE': return handleEnableTable(state, command, now);
  }
}

/**
 * コマンドを適用する。
 *
 * 成功すれば新しい状態と、起きたことのイベントを返す。拒否されれば理由を返し、
 * **元の状態は一切変わらない**（引数の状態をそのまま使い続けてよい）。
 *
 * 不変条件は毎回検査する。席 100・チケット 200 程度の規模では 1 回あたり
 * 数万回の比較で済み、コマンドの頻度（毎秒数件）に対して無視できる。
 * 本番で抽出検査に落とすかどうかは、実測してから Phase 2 で決める。
 */
export function apply(
  state: VenueState,
  command: Command,
  now: Timestamp,
): Result<Decision<VenueState, DomainEvent>, Rejection> {
  const wentBackward: Rejection | null = checkClock(state, now);
  if (wentBackward !== null) return err(wentBackward);

  const drafted: Outcome = route(state, command, now);
  if (!drafted.ok) return drafted;
  return settle(drafted.value, now);
}
