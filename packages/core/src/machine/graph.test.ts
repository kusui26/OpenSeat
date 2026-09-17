import { describe, expect, it } from 'vitest';
import {
  ambiguous,
  canReachAny,
  duplicates,
  eventsUsedIn,
  guardsUsedIn,
  incoming,
  outgoing,
  reachableFrom,
  statesIn,
} from './graph.js';
import type { Transition } from './transit.js';

type Node = 'A' | 'B' | 'C' | 'ISLAND' | 'SINK';
type Move = 'GO' | 'BACK' | 'END';
type Cond = 'ready' | 'notReady';

const row = (
  from: Node,
  on: Move,
  to: Node,
  guard: Cond | null = null,
): Transition<Node, Move, Cond> => ({ from, on, to, guard, source: '0.0', note: 'テスト用' });

/**
 * A → B → C → SINK と進み、B からは A へ戻れる。
 * ISLAND はどこからも到達できず、SINK からは出られない。
 */
const TABLE: readonly Transition<Node, Move, Cond>[] = [
  row('A', 'GO', 'B'),
  row('B', 'GO', 'C', 'ready'),
  row('B', 'BACK', 'A'),
  row('C', 'END', 'SINK'),
  row('ISLAND', 'GO', 'A'),
];

describe('outgoing / incoming', () => {
  it('その状態から出る遷移を返す', () => {
    expect(outgoing(TABLE, 'B').map((entry) => entry.to).sort()).toEqual(['A', 'C']);
  });

  it('その状態へ入る遷移を返す', () => {
    expect(incoming(TABLE, 'A').map((entry) => entry.from).sort()).toEqual(['B', 'ISLAND']);
  });

  it('出口が無い状態では空を返す', () => {
    expect(outgoing(TABLE, 'SINK')).toEqual([]);
  });

  it('入口が無い状態では空を返す', () => {
    expect(incoming(TABLE, 'ISLAND')).toEqual([]);
  });
});

describe('statesIn', () => {
  it('表に現れるすべての状態を集める', () => {
    expect([...statesIn(TABLE)].sort()).toEqual(['A', 'B', 'C', 'ISLAND', 'SINK']);
  });

  it('空の表からは空の集合', () => {
    expect(statesIn([]).size).toBe(0);
  });
});

describe('reachableFrom', () => {
  it('初期状態から辿れる状態をすべて返す', () => {
    expect([...reachableFrom(TABLE, ['A'])].sort()).toEqual(['A', 'B', 'C', 'SINK']);
  });

  it('到達できない状態は含まない', () => {
    expect(reachableFrom(TABLE, ['A']).has('ISLAND')).toBe(false);
  });

  it('初期状態自身は常に含まれる', () => {
    expect(reachableFrom(TABLE, ['SINK']).has('SINK')).toBe(true);
  });

  it('初期状態が複数あればすべてを出発点にする', () => {
    expect([...reachableFrom(TABLE, ['A', 'ISLAND'])].sort()).toEqual([
      'A',
      'B',
      'C',
      'ISLAND',
      'SINK',
    ]);
  });

  it('循環があっても止まる', () => {
    // A → B → A の循環があっても、無限には辿らない。
    expect(reachableFrom(TABLE, ['A']).size).toBe(4);
  });

  it('初期状態が空なら何も返さない', () => {
    expect(reachableFrom(TABLE, []).size).toBe(0);
  });
});

describe('canReachAny', () => {
  it('辿り着ければ真', () => {
    expect(canReachAny(TABLE, 'A', ['SINK'])).toBe(true);
  });

  it('辿り着けなければ偽', () => {
    expect(canReachAny(TABLE, 'SINK', ['A'])).toBe(false);
  });

  it('自分自身が目的地なら真', () => {
    expect(canReachAny(TABLE, 'SINK', ['SINK'])).toBe(true);
  });

  it('目的地が複数あれば、どれか 1 つに辿り着ければ真', () => {
    expect(canReachAny(TABLE, 'C', ['A', 'SINK'])).toBe(true);
  });

  it('目的地が空なら偽', () => {
    expect(canReachAny(TABLE, 'A', [])).toBe(false);
  });
});

describe('ambiguous', () => {
  it('同じ組み合わせに複数の行があり、無条件の行が混ざっていれば検出する', () => {
    const shadowed = [row('A', 'GO', 'B'), row('A', 'GO', 'C', 'ready')];
    expect(ambiguous(shadowed)).toHaveLength(1);
    expect(ambiguous(shadowed)[0]?.to).toBe('B');
  });

  it('すべてガードつきなら検出しない', () => {
    const guarded = [row('A', 'GO', 'B', 'ready'), row('A', 'GO', 'C', 'notReady')];
    expect(ambiguous(guarded)).toEqual([]);
  });

  it('行が 1 本だけなら、無条件でも検出しない', () => {
    expect(ambiguous([row('A', 'GO', 'B')])).toEqual([]);
  });

  it('健全な表では何も検出しない', () => {
    expect(ambiguous(TABLE)).toEqual([]);
  });
});

describe('duplicates', () => {
  it('まったく同じ行が二重にあれば検出する', () => {
    const doubled = [row('A', 'GO', 'B'), row('A', 'GO', 'B')];
    expect(duplicates(doubled)).toEqual(['A/GO/B/-']);
  });

  it('ガードが違えば別の行として扱う', () => {
    const different = [row('A', 'GO', 'B', 'ready'), row('A', 'GO', 'B', 'notReady')];
    expect(duplicates(different)).toEqual([]);
  });

  it('行き先が違えば別の行として扱う', () => {
    expect(duplicates([row('A', 'GO', 'B', 'ready'), row('A', 'GO', 'C', 'ready')])).toEqual([]);
  });

  it('健全な表では何も検出しない', () => {
    expect(duplicates(TABLE)).toEqual([]);
  });
});

describe('guardsUsedIn / eventsUsedIn', () => {
  it('参照されているガードを集める', () => {
    expect([...guardsUsedIn(TABLE)]).toEqual(['ready']);
  });

  it('無条件の行はガードとして数えない', () => {
    expect(guardsUsedIn([row('A', 'GO', 'B')]).size).toBe(0);
  });

  it('扱っている事象を集める', () => {
    expect([...eventsUsedIn(TABLE)].sort()).toEqual(['BACK', 'END', 'GO']);
  });
});
