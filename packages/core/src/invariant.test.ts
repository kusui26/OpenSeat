import { describe, expect, it } from 'vitest';
import {
  InvariantError,
  assertInvariants,
  checkInvariants,
  checkTransition,
  formatViolations,
  invariant,
  transitionInvariant,
  type Invariant,
  type TransitionInvariant,
} from './invariant.js';

interface Seats {
  readonly occupiedBy: readonly string[];
}

const atMostOneOccupant: Invariant<Seats> = invariant(
  'one_ticket_per_table',
  '1 つの席に有効なチケットは最大 1 枚',
  (state) => state.occupiedBy.length <= 1,
);

const noDuplicates: Invariant<Seats> = invariant(
  'no_duplicate_tickets',
  '同じチケットが二重に現れない',
  (state) => new Set(state.occupiedBy).size === state.occupiedBy.length,
);

const throwing: Invariant<Seats> = invariant('explodes', '述語が例外を投げる', () => {
  throw new Error('boom');
});

describe('checkInvariants', () => {
  it('健全な状態では違反を返さない', () => {
    expect(checkInvariants([atMostOneOccupant, noDuplicates], { occupiedBy: ['A-1'] })).toEqual([]);
  });

  it('破られた不変条件を名前つきで返す', () => {
    const violations = checkInvariants([atMostOneOccupant], { occupiedBy: ['A-1', 'A-2'] });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.name).toBe('one_ticket_per_table');
  });

  it('複数の違反をすべて返す', () => {
    const violations = checkInvariants([atMostOneOccupant, noDuplicates], {
      occupiedBy: ['A-1', 'A-1'],
    });
    expect(violations.map((v) => v.name)).toEqual(['one_ticket_per_table', 'no_duplicate_tickets']);
  });

  it('述語が例外を投げた場合も違反として扱う（検査自体で落ちない）', () => {
    expect(checkInvariants([throwing], { occupiedBy: [] })).toHaveLength(1);
  });

  it('不変条件が空なら常に健全', () => {
    expect(checkInvariants([], { occupiedBy: ['A-1', 'A-2'] })).toEqual([]);
  });
});

describe('checkTransition', () => {
  const idempotent: TransitionInvariant<Seats> = transitionInvariant(
    'tick_idempotent',
    '同じ時刻の tick は状態を変えない',
    (before, after) => before.occupiedBy.length === after.occupiedBy.length,
  );

  it('前後で条件が保たれていれば違反なし', () => {
    expect(checkTransition([idempotent], { occupiedBy: ['A'] }, { occupiedBy: ['B'] })).toEqual([]);
  });

  it('前後で条件が崩れたら違反を返す', () => {
    const violations = checkTransition([idempotent], { occupiedBy: [] }, { occupiedBy: ['A'] });
    expect(violations[0]?.name).toBe('tick_idempotent');
  });
});

describe('assertInvariants', () => {
  it('健全なら何も起きない', () => {
    expect(() => assertInvariants([atMostOneOccupant], { occupiedBy: [] })).not.toThrow();
  });

  it('違反があれば InvariantError を投げ、違反の内訳を持つ', () => {
    try {
      assertInvariants([atMostOneOccupant], { occupiedBy: ['A-1', 'A-2'] });
      expect.unreachable('例外が投げられるはず');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvariantError);
      if (error instanceof InvariantError) {
        expect(error.violations.map((v) => v.name)).toEqual(['one_ticket_per_table']);
        expect(error.message).toContain('one_ticket_per_table');
      }
    }
  });
});

describe('formatViolations', () => {
  it('違反を 1 行にまとめる', () => {
    const text = formatViolations([{ name: 'a', describe: 'A が壊れた' }]);
    expect(text).toBe('a: A が壊れた');
  });

  it('違反がなければ空文字', () => {
    expect(formatViolations([])).toBe('');
  });
});
