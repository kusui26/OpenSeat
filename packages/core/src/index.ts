/**
 * OpenSeat のドメインロジック。
 *
 * このパッケージは **依存ゼロ・純粋関数のみ** で構成する。I/O、`Date.now()`、
 * `Math.random()`、`process.env`、Node の組み込みモジュールを使わない。
 * 制約の根拠は ADR-0004、検査は `scripts/check-architecture.mjs` にある。
 *
 * 土台（時刻の扱い、呼び出し規約、不変条件）とドメインの型を公開する。
 * 状態機械・割当アルゴリズム・待ち時間推定は Phase 1 の後続の PR で実装する。
 */

export type { Timestamp, DurationMs } from './time.js';
export {
  SECOND_MS,
  MINUTE_MS,
  minutes,
  seconds,
  after,
  hasPassed,
  remaining,
  elapsedSince,
} from './time.js';

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

export type { VenueState, CreateVenueStateParams } from './domain/state.js';
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
  effectiveMaxPartySize,
  withTable,
  withTicket,
  sameTable,
  sameTicket,
  sameVenueState,
} from './domain/state.js';

// ---- 状態機械（Phase 1 PR 2）----

export type { Transition, TransitOutcome, GuardEvaluator } from './machine/transit.js';
export { matching, transit } from './machine/transit.js';

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

export type { TicketEvent, TicketGuard, TicketTransition } from './machine/ticket-machine.js';
export {
  TICKET_EVENTS,
  TICKET_GUARDS,
  TICKET_TRANSITIONS,
  TICKET_INITIAL_STATES,
  MAX_AGE_APPLIES_TO,
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
  noStarvation,
  priorityPreservedAcrossPause,
  tickIdempotent,
} from './machine/invariants.js';

// ---- 割当の選択（Phase 1 PR 4）----

export type { Assignment, AssignmentReason, Pick } from './allocation/choose.js';
export {
  ASSIGNMENT_REASONS,
  orderTables,
  assignableTables,
  candidatesFor,
  waste,
  pickCandidate,
  chooseAssignments,
} from './allocation/choose.js';
