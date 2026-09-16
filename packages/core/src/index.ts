/**
 * OpenSeat のドメインロジック。
 *
 * このパッケージは **依存ゼロ・純粋関数のみ** で構成する。I/O、`Date.now()`、
 * `Math.random()`、`process.env`、Node の組み込みモジュールを使わない。
 * 制約の根拠は ADR-0004、検査は `scripts/check-architecture.mjs` にある。
 *
 * 状態機械・割当アルゴリズム・待ち時間推定は Phase 1 で実装する。
 * ここにあるのは、それらが乗る土台（時刻の扱い、呼び出し規約、不変条件）である。
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
