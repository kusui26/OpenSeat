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
 * という設計（全体プラン 9.4）に対応する。
 */

import {
  allocateTicketCode,
  effectiveMaxPartySize,
  findTable,
  findTicket,
  queuedTickets,
  withTicket,
  type VenueState,
} from '../domain/state.js';
import { createTicket, type EndReason, type Ticket, type TicketState } from '../domain/ticket.js';
import type { Table } from '../domain/table.js';
import type { TicketCode, TicketId } from '../domain/ids.js';
import { checkInvariants, formatViolations } from '../invariant.js';
import { err, ok, type Result } from '../result.js';
import type { Timestamp } from '../time.js';
import type { Decision } from '../decision.js';
import { runAllocation } from './allocate.js';
import {
  CANCEL_END_REASONS,
  type CancelCommand,
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
import { POST_ALLOCATION_INVARIANTS, STATE_INVARIANTS } from './invariants.js';
import { rejection, type Rejection } from './rejection.js';
import { clearedHold, endedTicket, releaseHeldTable } from './release.js';
import { HEARTBEAT_APPLIES_TO, PARTY_SIZE_CHANGE_APPLIES_TO } from './ticket-machine.js';
import { ticketTransition } from './transition.js';

/** 手順 4 までで組み立てた変更。まだ割当も検査も通っていない。 */
export type Draft = Decision<VenueState, DomainEvent>;

type Outcome = Result<Draft, Rejection>;

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
    events: [
      { type: 'TicketJoined', at: now, ticketId: ticket.id, code: ticket.code, partySize: ticket.partySize },
    ],
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
    events: [cancelled(ticket, command, endReason, now), ...released.value.events],
  });
}

function cancelled(
  ticket: Ticket,
  command: CancelCommand,
  endReason: EndReason,
  now: Timestamp,
): DomainEvent {
  return {
    type: 'TicketEnded',
    at: now,
    ticketId: ticket.id,
    endReason,
    by: command.by,
    cancelReason: command.reason,
  };
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

// ---- 入口 ----

/** コマンドを担当する処理へ振り分ける（手順 1〜4）。 */
function route(state: VenueState, command: Command, now: Timestamp): Outcome {
  switch (command.type) {
    case 'JOIN':
      return handleJoin(state, command, now);
    case 'CANCEL':
      return handleCancel(state, command, now);
    case 'PAUSE':
      return handlePause(state, command, now);
    case 'READY':
      return handleReady(state, command, now);
    case 'EXTEND':
      return handleExtend(state, command, now);
    case 'PASS':
      return handlePass(state, command, now);
    case 'CHANGE_PARTY_SIZE':
      return handleChangePartySize(state, command, now);
    case 'HEARTBEAT':
      return handleHeartbeat(state, command, now);
  }
}

/**
 * 割当を実行し、不変条件を検査して締める（手順 5〜7）。
 *
 * **`apply` と `tick` が共有する出口である。** どちらもここを通らずに状態を返さない。
 * `no_starvation`（収まる空席があるのに待ちが残らない）をここで検査できるのは、
 * 直前に割当を実行しているからである（PR 3 で常時検査から外した条件が戻ってくる）。
 */
export function settle(drafted: Draft, now: Timestamp): Outcome {
  const allocated = runAllocation(drafted.state, now);
  if (!allocated.ok) return err(allocated.error);

  const violations = checkInvariants(
    [...STATE_INVARIANTS, ...POST_ALLOCATION_INVARIANTS],
    allocated.value.state,
  );
  if (violations.length > 0) {
    return err(rejection('INVARIANT_VIOLATED', formatViolations(violations)));
  }
  return ok({
    state: allocated.value.state,
    events: [...drafted.events, ...allocated.value.events],
  });
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
  const drafted: Outcome = route(state, command, now);
  if (!drafted.ok) return drafted;
  return settle(drafted.value, now);
}
