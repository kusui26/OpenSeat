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
} from './domain/state.js';
