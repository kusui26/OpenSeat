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
 * 5. **不変条件を検査する。破れていたら変更を破棄して拒否する**
 * 6. 起きたことをイベントとして返す
 *
 * **手順 5 を飛ばせないようにしてある。** 各コマンドの処理は module 内に閉じて
 * いて外から呼べず、`apply` だけが export されている。どの処理がどう状態を
 * 組み立てても、出口の検査を通らずに `VenueState` が外へ出ることはない
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
  findTicket,
  queuedTickets,
  withTable,
  withTicket,
  type VenueState,
} from '../domain/state.js';
import { createTicket, type EndReason, type Ticket, type TicketState } from '../domain/ticket.js';
import type { Policy } from '../domain/policy.js';
import type { Table, TableStatus } from '../domain/table.js';
import type { TicketCode, TicketId } from '../domain/ids.js';
import { checkInvariants, formatViolations } from '../invariant.js';
import { err, ok, type Result } from '../result.js';
import { minutes, type DurationMs, type Timestamp } from '../time.js';
import type { Decision } from '../decision.js';
import {
  CANCEL_END_REASONS,
  type CancelCommand,
  type ChangePartySizeCommand,
  type Command,
  type HeartbeatCommand,
  type JoinCommand,
  type PauseCommand,
  type ReadyCommand,
} from './command.js';
import type { DomainEvent } from './events.js';
import {
  evaluateTableGuard,
  evaluateTicketGuard,
  tableGuardIsImplemented,
  ticketGuardIsImplemented,
} from './guards.js';
import { STATE_INVARIANTS } from './invariants.js';
import { rejection, type Rejection } from './rejection.js';
import { TABLE_TRANSITIONS, type TableEvent } from './table-machine.js';
import {
  HEARTBEAT_APPLIES_TO,
  PARTY_SIZE_CHANGE_APPLIES_TO,
  TICKET_TRANSITIONS,
  type TicketEvent,
} from './ticket-machine.js';
import { transit } from './transit.js';

/** 手順 4 までで組み立てた変更。まだ検査を通っていない。 */
type Draft = Decision<VenueState, DomainEvent>;

type Outcome = Result<Draft, Rejection>;

// ---- 手順 2・3: 遷移表とガード ----

/**
 * チケットに事象を起こしたときの行き先を求める。**状態は作らない。**
 *
 * 返すのは次の状態の名前だけなので、この関数を経由しても不変条件の検査を
 * 迂回できない。PR 6 以降もこれを通して遷移させること。
 */
export function ticketTransition(
  state: VenueState,
  ticket: Ticket,
  event: TicketEvent,
  now: Timestamp,
): Result<TicketState, Rejection> {
  const outcome = transit(TICKET_TRANSITIONS, ticket.state, event, (guard) =>
    evaluateTicketGuard({ state, ticket, now }, guard),
  );
  if (outcome.kind === 'moved') return ok(outcome.to);
  if (outcome.kind === 'undeclared') {
    return err(rejection('NOT_ALLOWED_IN_STATE', `${ticket.state} のチケットに ${event} は起こせない`));
  }
  return err(blocked(outcome.tried, ticketGuardIsImplemented));
}

/** テーブルに事象を起こしたときの行き先を求める。 */
export function tableTransition(
  state: VenueState,
  table: Table,
  event: TableEvent,
  now: Timestamp,
): Result<TableStatus, Rejection> {
  const outcome = transit(TABLE_TRANSITIONS, table.status, event, (guard) =>
    evaluateTableGuard({ state, table, now }, guard),
  );
  if (outcome.kind === 'moved') return ok(outcome.to);
  if (outcome.kind === 'undeclared') {
    return err(rejection('NOT_ALLOWED_IN_STATE', `${table.status} の席に ${event} は起こせない`));
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

// ---- 保留の期限（全体プラン 7.7 の 7） ----

/** まだ保留していられる時間。`pauseMaxTotalMin` から使った分を引いたもの。 */
export function remainingPauseBudget(ticket: Ticket, policy: Policy): DurationMs {
  const cap: DurationMs = minutes(policy.pauseMaxTotalMin);
  return cap > ticket.pausedTotal ? cap - ticket.pausedTotal : 0;
}

/**
 * これから入る保留の期限。
 *
 * 1 回に延びるのは `pauseStepMin` まで。ただし合計が `pauseMaxTotalMin` を
 * 超えないように切り詰める。**1 つの仕掛け（期限）で 2 つのパラメータを守る。**
 * 残りが尽きている人の期限は現在時刻になり、次の `tick` で期限切れになる。
 */
export function pauseDeadlineFor(ticket: Ticket, policy: Policy, now: Timestamp): Timestamp {
  return now + Math.min(minutes(policy.pauseStepMin), remainingPauseBudget(ticket, policy));
}

/** 保留を閉じるときに書き換える欄。使った時間を合計へ足し込む。 */
function closedPause(ticket: Ticket, now: Timestamp): Pick<Ticket, 'pauseDeadline' | 'pausedSince' | 'pausedTotal'> {
  const spent: DurationMs = ticket.pausedSince === null ? 0 : Math.max(0, now - ticket.pausedSince);
  return { pauseDeadline: null, pausedSince: null, pausedTotal: ticket.pausedTotal + spent };
}

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
  const moved = ticketTransition(state, ticket, 'CANCEL', now);
  if (!moved.ok) return err(moved.error);

  const released = releaseHeldTable(state, ticket, now);
  if (!released.ok) return err(released.error);

  const endReason = CANCEL_END_REASONS[command.by];
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
    type: 'TicketCancelled',
    at: now,
    ticketId: ticket.id,
    by: command.by,
    reason: command.reason,
    endReason,
  };
}

/**
 * 終端へ落ちたチケットの欄を揃える。
 *
 * 席との結びつきとホールドの期限を必ず外す。残っていると、その席が誰にも
 * 割り当てられなくなり、`terminal_holds_no_table` が破れる。呼び出された時刻
 * （`calledAt`）は履歴として残す。
 */
function endedTicket(ticket: Ticket, to: TicketState, endReason: EndReason, now: Timestamp): Ticket {
  return {
    ...ticket,
    ...closedPause(ticket, now),
    state: to,
    endedAt: now,
    endReason,
    tableId: null,
    holdDeadline: null,
  };
}

/**
 * 確保していた席を空席に戻す（全体プラン 7.9「`CALLED` 中なら席は即 `FREE`」）。
 *
 * **次の人への割当はここでは行わない。** 割当の実行は PR 6 が 1 か所に集める。
 * `verifiedFreeAt` も更新しない。誰も座っていないので、この席が空いていることの
 * 確からしさは確保する前から変わっていない。
 *
 * 席が見つからない場合は、何もせずに取り消しを続ける。その状態はすでに
 * `assigned_has_table` が破れているので、取り消しはむしろ食い違いを解消する。
 */
function releaseHeldTable(state: VenueState, ticket: Ticket, now: Timestamp): Outcome {
  if (ticket.tableId === null) return ok({ state, events: [] });
  const table: Table | undefined = state.tables.find((candidate) => candidate.id === ticket.tableId);
  if (table === undefined) return ok({ state, events: [] });

  const moved = tableTransition(state, table, 'RELEASE', now);
  if (!moved.ok) return err(moved.error);
  const freed: Table = { ...table, status: moved.value, statusSince: now, occupantTicketId: null };
  return ok({
    state: withTable(state, freed),
    events: [{ type: 'TableFreed', at: now, tableId: freed.id, releasedTicketId: ticket.id }],
  });
}

// ---- 保留と準備OK（全体プラン 7.7 の 5〜7） ----

function handlePause(state: VenueState, command: PauseCommand, now: Timestamp): Outcome {
  const found = requireTicket(state, command.ticketId);
  if (!found.ok) return err(found.error);
  const ticket: Ticket = found.value;

  const moved = ticketTransition(state, ticket, 'PAUSE', now);
  if (!moved.ok) return err(moved.error);

  const until: Timestamp = pauseDeadlineFor(ticket, state.policy, now);
  const paused: Ticket = { ...ticket, state: moved.value, pauseDeadline: until, pausedSince: now };
  return ok({
    state: withTicket(state, paused),
    events: [{ type: 'TicketPaused', at: now, ticketId: ticket.id, until }],
  });
}

function handleReady(state: VenueState, command: ReadyCommand, now: Timestamp): Outcome {
  const found = requireTicket(state, command.ticketId);
  if (!found.ok) return err(found.error);
  const ticket: Ticket = found.value;

  const moved = ticketTransition(state, ticket, 'READY', now);
  if (!moved.ok) return err(moved.error);

  // priorityAt には触れない。保留を挟んでも順番が変わらないことが、譲る動機を守る。
  const resumed: Ticket = { ...ticket, ...closedPause(ticket, now), state: moved.value };
  return ok({
    state: withTicket(state, resumed),
    events: [{ type: 'TicketResumed', at: now, ticketId: ticket.id }],
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
    case 'CHANGE_PARTY_SIZE':
      return handleChangePartySize(state, command, now);
    case 'HEARTBEAT':
      return handleHeartbeat(state, command, now);
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
  const drafted: Outcome = route(state, command, now);
  if (!drafted.ok) return drafted;

  const violations = checkInvariants(STATE_INVARIANTS, drafted.value.state);
  if (violations.length > 0) {
    return err(rejection('INVARIANT_VIOLATED', formatViolations(violations)));
  }
  return ok(drafted.value);
}
