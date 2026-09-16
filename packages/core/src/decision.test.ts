import { describe, expect, it } from 'vitest';
import { decided, sequence, unchanged, type Decision } from './decision.js';

interface Counter {
  readonly value: number;
}

type CounterEvent = { readonly type: 'incremented'; readonly to: number };

function increment(state: Counter): Decision<Counter, CounterEvent> {
  const next: Counter = { value: state.value + 1 };
  return decided(next, [{ type: 'incremented', to: next.value }]);
}

describe('unchanged', () => {
  it('状態をそのまま返し、イベントを出さない', () => {
    const state: Counter = { value: 3 };
    const result: Decision<Counter, CounterEvent> = unchanged(state);
    expect(result.state).toBe(state);
    expect(result.events).toEqual([]);
  });
});

describe('decided', () => {
  it('新しい状態とイベントを返す', () => {
    const result: Decision<Counter, CounterEvent> = increment({ value: 0 });
    expect(result.state.value).toBe(1);
    expect(result.events).toEqual([{ type: 'incremented', to: 1 }]);
  });

  it('元の状態を破壊しない', () => {
    const before: Counter = { value: 0 };
    increment(before);
    expect(before.value).toBe(0);
  });
});

describe('sequence', () => {
  it('2 つの決定を順に適用し、イベントを順序どおり連結する', () => {
    const result = sequence(increment({ value: 0 }), increment);
    expect(result.state.value).toBe(2);
    expect(result.events).toEqual([
      { type: 'incremented', to: 1 },
      { type: 'incremented', to: 2 },
    ]);
  });

  it('何も起きない決定を挟んでもイベントが増えない', () => {
    const result = sequence(unchanged<Counter, CounterEvent>({ value: 5 }), unchanged);
    expect(result.state.value).toBe(5);
    expect(result.events).toEqual([]);
  });
});
