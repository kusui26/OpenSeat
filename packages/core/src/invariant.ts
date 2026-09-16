/**
 * 不変条件。
 *
 * 「1 つの席に有効なチケットは最大 1 枚」のように、破られたら製品が成立しない
 * 条件を **名前付きの述語として 1 か所に宣言** する。同じ宣言を、実行時の検査・
 * 性質テスト・シミュレーションのファズ判定の 3 か所で使う。二重に書かない
 * （ADR-0004、CLAUDE.md 3.2）。
 */

/** 1 つの状態について成り立つべき条件。 */
export interface Invariant<State> {
  readonly name: string;
  readonly describe: string;
  readonly holds: (state: State) => boolean;
}

/** 状態遷移の前後について成り立つべき条件。冪等性や順序の保存に使う。 */
export interface TransitionInvariant<State> {
  readonly name: string;
  readonly describe: string;
  readonly holds: (before: State, after: State) => boolean;
}

/** 破られた不変条件。 */
export interface Violation {
  readonly name: string;
  readonly describe: string;
}

/** 不変条件を宣言する。 */
export function invariant<State>(
  name: string,
  describe: string,
  holds: (state: State) => boolean,
): Invariant<State> {
  return { name, describe, holds };
}

/** 遷移の不変条件を宣言する。 */
export function transitionInvariant<State>(
  name: string,
  describe: string,
  holds: (before: State, after: State) => boolean,
): TransitionInvariant<State> {
  return { name, describe, holds };
}

/** 述語が例外を投げた場合も違反として扱う。検査自体で落ちないようにする。 */
function violatedBy(passed: boolean, source: Violation): readonly Violation[] {
  return passed ? [] : [source];
}

function evaluate<State>(item: Invariant<State>, state: State): readonly Violation[] {
  const source: Violation = { name: item.name, describe: item.describe };
  try {
    return violatedBy(item.holds(state), source);
  } catch {
    return [source];
  }
}

/** 破られた不変条件を列挙する。空配列なら健全。 */
export function checkInvariants<State>(
  invariants: readonly Invariant<State>[],
  state: State,
): readonly Violation[] {
  return invariants.flatMap((item) => evaluate(item, state));
}

function evaluateTransition<State>(
  item: TransitionInvariant<State>,
  before: State,
  after: State,
): readonly Violation[] {
  const source: Violation = { name: item.name, describe: item.describe };
  try {
    return violatedBy(item.holds(before, after), source);
  } catch {
    return [source];
  }
}

/** 遷移の不変条件について、破られたものを列挙する。 */
export function checkTransition<State>(
  invariants: readonly TransitionInvariant<State>[],
  before: State,
  after: State,
): readonly Violation[] {
  return invariants.flatMap((item) => evaluateTransition(item, before, after));
}

/** 違反を人が読める 1 行にする。 */
export function formatViolations(violations: readonly Violation[]): string {
  return violations.map((item) => `${item.name}: ${item.describe}`).join(' / ');
}

/** 不変条件の違反を表す。呼び出し側はこれを捕捉して変更を破棄する。 */
export class InvariantError extends Error {
  readonly violations: readonly Violation[];

  constructor(violations: readonly Violation[]) {
    super(`不変条件の違反: ${formatViolations(violations)}`);
    this.name = 'InvariantError';
    this.violations = violations;
  }
}

/**
 * 違反があれば例外を投げる。
 *
 * 呼び出し側の責務は「壊れた状態を書き込まないこと」である。捕捉したら
 * その変更を破棄し、失敗として返すこと。握り潰さない（CLAUDE.md 6 章）。
 */
export function assertInvariants<State>(
  invariants: readonly Invariant<State>[],
  state: State,
): void {
  const violations: readonly Violation[] = checkInvariants(invariants, state);
  if (violations.length > 0) {
    throw new InvariantError(violations);
  }
}
