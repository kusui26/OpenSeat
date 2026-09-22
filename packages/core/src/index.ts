/**
 * OpenSeat のドメインロジック。
 *
 * このパッケージは **依存ゼロ・純粋関数のみ** で構成する。I/O、`Date.now()`、
 * `Math.random()`、`process.env`、Node の組み込みモジュールを使わない。
 * 制約の根拠は ADR-0004、検査は `scripts/check-architecture.mjs` にある。
 *
 * 土台（時刻の扱い、呼び出し規約、不変条件）、ドメインの型、状態機械、割当、
 * 座席 QR の分岐、運用時間帯を公開する。**状態を変えられる入口は `apply` と
 * `tick` の 2 つだけ**にしてある（CLAUDE.md 3 章）。待ち時間の推定（ETA）は
 * Phase 1 の PR 13 で足す。
 */

export type { Timestamp, DurationMs } from './time.js';
export {
  SECOND_MS,
  MINUTE_MS,
  minutes,
  seconds,
  after,
  hasPassed,
  reached,
  remaining,
  elapsedSince,
} from './time.js';

export type { Result } from './result.js';
export { ok, err, isOk, isErr } from './result.js';

export type { Decision, Apply, Tick } from './decision.js';
export { unchanged, decided, sequence } from './decision.js';

export type { Invariant, TransitionInvariant, Violation } from './invariant.js';
export {
  invariant,
  transitionInvariant,
  checkInvariants,
  checkTransition,
  formatViolations,
  assertInvariants,
  InvariantError,
} from './invariant.js';

// ---- ドメイン（Phase 1 PR 1）----

export type { VenueId, TableId, TicketId, TicketCode, TableLabel, Tag } from './domain/ids.js';

export type { Actor, Role, Side } from './domain/actor.js';
export { ANONYMOUS, ROLES, SIDES, member, sideOf, ticketOwner } from './domain/actor.js';

export type {
  Table,
  TableStatus,
  TakenTableStatus,
  CreateTableParams,
} from './domain/table.js';
export {
  TABLE_STATUSES,
  TAKEN_TABLE_STATUSES,
  createTable,
  leftService,
  isTaken,
  fitsCapacity,
  satisfiesTags,
} from './domain/table.js';

export type {
  Ticket,
  TicketState,
  TerminalTicketState,
  ActiveTicketState,
  EndReason,
  CreateTicketParams,
} from './domain/ticket.js';
export {
  TICKET_STATES,
  TERMINAL_TICKET_STATES,
  ACTIVE_TICKET_STATES,
  END_REASONS,
  END_REASON_STATES,
  createTicket,
  isTerminal,
  isActive,
  holdsTable,
  comparePriority,
} from './domain/ticket.js';

export type {
  Policy,
  PolicyProblem,
  NoShowPolicy,
  TimeLimitMode,
  TableOrderKey,
} from './domain/policy.js';
export {
  NO_SHOW_POLICIES,
  TIME_LIMIT_MODES,
  TABLE_ORDER_KEYS,
  DEFAULT_POLICY,
  validatePolicy,
} from './domain/policy.js';

export type { VenueState, CreateVenueStateParams, CodeAllocation } from './domain/state.js';
export {
  CODE_SPACE_SIZE,
  createVenueState,
  findTable,
  findTicket,
  activeTickets,
  waitingTickets,
  managedTables,
  ticketCodeFor,
  nextTicketCode,
  allocateTicketCode,
  queuedTickets,
  effectiveMaxPartySize,
  withTable,
  withTicket,
  sameTable,
  sameTicket,
  sameVenueState,
} from './domain/state.js';

// ---- 状態機械（Phase 1 PR 2）----

export type { Transition, TransitOutcome, GuardEvaluator } from './machine/transit.js';
export { matching, taken, transit } from './machine/transit.js';

export {
  outgoing,
  incoming,
  statesIn,
  reachableFrom,
  canReachAny,
  ambiguous,
  duplicates,
  guardsUsedIn,
  eventsUsedIn,
} from './machine/graph.js';

export type {
  TicketEvent,
  TicketGuard,
  TicketTransition,
  TicketOrigin,
} from './machine/ticket-machine.js';
export {
  TICKET_EVENTS,
  TICKET_GUARDS,
  TICKET_TRANSITIONS,
  TICKET_INITIAL_STATES,
  MAX_AGE_APPLIES_TO,
  HEARTBEAT_APPLIES_TO,
  PARTY_SIZE_CHANGE_APPLIES_TO,
  CONFLICT_PRIORITY_APPLIES_TO,
} from './machine/ticket-machine.js';

export type { TableEvent, TableGuard, TableTransition } from './machine/table-machine.js';
export {
  TABLE_EVENTS,
  TABLE_GUARDS,
  TABLE_TRANSITIONS,
  TABLE_INITIAL_STATE,
  CLOSE_APPLIES_TO,
} from './machine/table-machine.js';

// ---- 不変条件（Phase 1 PR 3）----

export {
  STATE_INVARIANTS,
  POST_ALLOCATION_INVARIANTS,
  TRANSITION_INVARIANTS,
  ALL_INVARIANT_NAMES,
  uniqueIds,
  uniqueActiveCodes,
  assignedHasTable,
  terminalHoldsNoTable,
  tableLinkIsMutual,
  assignmentStatusMatches,
  oneTicketPerTable,
  assignedPartyFitsCapacity,
  heldTableHasDeadline,
  stateTimestampsAreSet,
  endReasonMatchesState,
  joinRequiresOperating,
  unmanagedTableIsDisabled,
  disabledTableHasNoReservation,
  noStarvation,
  priorityPreservedAcrossPause,
  tickIdempotent,
} from './machine/invariants.js';

// ---- 割当の選択（Phase 1 PR 4）----

export type { Assignment, AssignmentReason, CandidatePick } from './allocation/choose.js';
export type { Suggestion } from './allocation/needs-check.js';
export {
  ASSIGNMENT_REASONS,
  orderTables,
  assignableTables,
  candidatesFor,
  waste,
  pickCandidate,
  chooseAssignments,
} from './allocation/choose.js';
export { suggestNeedsCheck, uncertainTables, guidedTo } from './allocation/needs-check.js';

// ---- コマンドの適用（Phase 1 PR 5）----

export type {
  Command,
  CommandType,
  CancelReason,
  JoinCommand,
  CancelCommand,
  PauseCommand,
  ReadyCommand,
  ExtendCommand,
  PassCommand,
  CheckInCommand,
  CheckOutCommand,
  SwapTableCommand,
  CheckInEarlyCommand,
  WalkInCommand,
  ReportTakenCommand,
  ReportInUseCommand,
  ConfirmFreeCommand,
  StillHereCommand,
  ChangePartySizeCommand,
  HeartbeatCommand,
  OpenCommand,
  CloseCommand,
  ReleaseAllCommand,
  DisableTableCommand,
  EnableTableCommand,
} from './machine/command.js';
export {
  CANCEL_REASONS,
  CANCEL_END_REASONS,
  CHECKOUT_END_REASONS,
  COMMAND_TYPES,
} from './machine/command.js';

// ---- 運用時間帯（Phase 1 PR 11）----

export type {
  Weekday,
  LocalTime,
  ManagedWindow,
  ManagedSchedule,
  ScheduleProblem,
} from './schedule.js';
export {
  WEEKDAYS,
  MINUTES_PER_DAY,
  windowAt,
  isManaged,
  remainingToday,
  closesAtOf,
  validateSchedule,
} from './schedule.js';

export type { Rejection, RejectionCode } from './machine/rejection.js';
export { REJECTION_CODES, rejection, isDefect } from './machine/rejection.js';

export type {
  DomainEvent,
  DomainEventType,
  PauseReason,
  RequeueReason,
  NeedsCheckReason,
  TicketJoined,
  TicketCalled,
  TableHeld,
  TicketReminded,
  TicketExtended,
  TicketPaused,
  TicketResumed,
  TicketRequeued,
  TicketSwapped,
  TableReportedInUse,
  TicketSeated,
  TableOccupied,
  TableVacated,
  PartySizeChanged,
  TicketEnded,
  TableFreed,
  TableDisabled,
  TimeLimitReached,
  StillHereAsked,
  StillHereAnswered,
  TableNeedsCheck,
  CloseReason,
  VenueOpened,
  JoinClosed,
  VenueClosed,
} from './machine/events.js';
export {
  DOMAIN_EVENT_TYPES,
  PAUSE_REASONS,
  REQUEUE_REASONS,
  NEEDS_CHECK_REASONS,
  CLOSE_REASONS,
} from './machine/events.js';

export type { TicketGuardContext, TableGuardContext } from './machine/guards.js';
export {
  ticketGuardIsImplemented,
  tableGuardIsImplemented,
  unimplementedTicketGuards,
  unimplementedTableGuards,
  evaluateTicketGuard,
  evaluateTableGuard,
} from './machine/guards.js';

// **外から見える入口は `dispatch` と `tick` の 2 つだけである**（CLAUDE.md 3 章）。
//
// `apply` は公開しない。公開すると**権限を通らずに状態を変える道**ができてしまう。
// `settle`（割当と検査の出口）と `Draft` も同じ理由で外に出さない。
export { dispatch } from './machine/dispatch.js';

export { PERMISSIONS, isPermitted, ownsTarget, targetTicketId } from './domain/permissions.js';

export {
  ticketTransition,
  tableTransition,
  ticketTransitionRow,
  tableTransitionRow,
} from './machine/transition.js';

export type { StartedPause } from './machine/deadlines.js';
export {
  holdDeadlineFor,
  extendedHoldDeadline,
  holdReminderAt,
  holdExpiresAt,
  canExtendHold,
  remainingPauseBudget,
  pauseWindowEnd,
  pauseDeadlineFor,
  pauseExpiresAt,
  startedPause,
  closedPause,
  maxAgeAt,
  abandonedAt,
  turnoverEndsAt,
  timeLimitNoticeAt,
  overstayAt,
  stillHereAskAt,
  stillHereTimeoutAt,
  unknownAgedAt,
  autoFreeAt,
  venueCloseAt,
  joinCutoffAt,
  venueClosesAt,
} from './machine/deadlines.js';

// ---- 呼び出し・ホールド・ノーショー（Phase 1 PR 6）----

export { runAllocation } from './machine/allocate.js';
export {
  clearedHold,
  clearedHoldDeadline,
  clearedSeatedNotices,
  endedTicket,
  releaseHeldTable,
} from './machine/release.js';
export { tick } from './machine/tick.js';

// ---- 座席 QR の分岐（Phase 1 PR 9）----

export type { TableScanKind, TableScanOutcome } from './scan/resolve.js';
export { TABLE_SCAN_KINDS, resolveTableScan } from './scan/resolve.js';

// ---- 待ち時間の推定（Phase 1 PR 13）----

export type { WaitEstimate, PartyToSeat } from './eta.js';
export { estimateForJoin, estimateForTicket } from './eta.js';
