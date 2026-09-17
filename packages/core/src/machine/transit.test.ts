import { describe, expect, it } from 'vitest';
import { matching, transit, type Transition } from './transit.js';

/** 汎用の挙動だけを見るための、小さな作り物の状態機械。 */
type Light = 'RED' | 'GREEN' | 'BROKEN';
type Signal = 'TICK' | 'SMASH' | 'FIX';
type Check = 'hasPower' | 'hasParts';

const TABLE: readonly Transition<Light, Signal, Check>[] = [
  { from: 'RED', on: 'TICK', to: 'GREEN', guard: 'hasPower', source: '0.1', note: '通電していれば青に変わる' },
  { from: 'GREEN', on: 'TICK', to: 'RED', guard: null, source: '0.1', note: '時間が来れば赤に戻る' },
  { from: 'RED', on: 'SMASH', to: 'BROKEN', guard: null, source: '0.2', note: '壊れた' },
  { from: 'GREEN', on: 'SMASH', to: 'BROKEN', guard: null, source: '0.2', note: '壊れた' },
  { from: 'BROKEN', on: 'FIX', to: 'RED', guard: 'hasParts', source: '0.3', note: '部品があれば直る' },
];

const ALL_PASS = (): boolean => true;
const ALL_FAIL = (): boolean => false;

describe('matching', () => {
  it('その状態とその事象に宣言されている行を返す', () => {
    expect(matching(TABLE, 'RED', 'TICK')).toHaveLength(1);
  });

  it('宣言が無ければ空', () => {
    expect(matching(TABLE, 'BROKEN', 'TICK')).toEqual([]);
  });

  it('状態が違えば拾わない', () => {
    expect(matching(TABLE, 'GREEN', 'FIX')).toEqual([]);
  });
});

describe('transit', () => {
  it('ガードが通れば moved で、行き先とガード名を返す', () => {
    const outcome = transit(TABLE, 'RED', 'TICK', ALL_PASS);
    expect(outcome).toEqual({ kind: 'moved', to: 'GREEN', guard: 'hasPower' });
  });

  it('無条件の遷移は、ガードの評価がすべて偽でも通る', () => {
    const outcome = transit(TABLE, 'GREEN', 'TICK', ALL_FAIL);
    expect(outcome).toEqual({ kind: 'moved', to: 'RED', guard: null });
  });

  it('宣言が無ければ undeclared', () => {
    expect(transit(TABLE, 'BROKEN', 'TICK', ALL_PASS)).toEqual({ kind: 'undeclared' });
  });

  it('宣言はあるがガードが通らなければ blocked で、試したガードが分かる', () => {
    expect(transit(TABLE, 'RED', 'TICK', ALL_FAIL)).toEqual({
      kind: 'blocked',
      tried: ['hasPower'],
    });
  });

  it('undeclared と blocked は区別される', () => {
    // undeclared は「その状態ではそもそも起こりえない」、
    // blocked は「起こりうるが、いまは条件を満たさない」。
    // 前者は呼び出し側の誤り、後者は正当な拒否なので、扱いを分ける必要がある。
    expect(transit(TABLE, 'BROKEN', 'TICK', ALL_FAIL).kind).toBe('undeclared');
    expect(transit(TABLE, 'BROKEN', 'FIX', ALL_FAIL).kind).toBe('blocked');
  });

  it('評価関数には、宣言されたガードの名前だけが渡される', () => {
    const seen: string[] = [];
    transit(TABLE, 'RED', 'TICK', (guard) => {
      seen.push(guard);
      return false;
    });
    expect(seen).toEqual(['hasPower']);
  });

  it('無条件の行では評価関数が呼ばれない', () => {
    let called = 0;
    transit(TABLE, 'GREEN', 'TICK', () => {
      called += 1;
      return true;
    });
    expect(called).toBe(0);
  });

  describe('同じ組み合わせに複数の行があるとき', () => {
    const branching: readonly Transition<Light, Signal, Check>[] = [
      { from: 'RED', on: 'TICK', to: 'GREEN', guard: 'hasPower', source: '0.1', note: '通電あり' },
      { from: 'RED', on: 'TICK', to: 'BROKEN', guard: 'hasParts', source: '0.1', note: '通電なし' },
    ];

    it('宣言の順に評価し、最初に通った行を採る', () => {
      const first = transit(branching, 'RED', 'TICK', (g) => g === 'hasPower');
      const second = transit(branching, 'RED', 'TICK', (g) => g === 'hasParts');
      expect(first.kind === 'moved' && first.to).toBe('GREEN');
      expect(second.kind === 'moved' && second.to).toBe('BROKEN');
    });

    it('どれも通らなければ、試したガードをすべて返す', () => {
      const outcome = transit(branching, 'RED', 'TICK', ALL_FAIL);
      expect(outcome.kind === 'blocked' && outcome.tried).toEqual(['hasPower', 'hasParts']);
    });

    it('複数が同時に成立する場合は、先に宣言された行が勝つ', () => {
      const outcome = transit(branching, 'RED', 'TICK', ALL_PASS);
      expect(outcome.kind === 'moved' && outcome.to).toBe('GREEN');
    });
  });

  it('空の表では常に undeclared', () => {
    expect(transit([], 'RED', 'TICK', ALL_PASS)).toEqual({ kind: 'undeclared' });
  });

  it('表を書き換えない', () => {
    const before = JSON.stringify(TABLE);
    transit(TABLE, 'RED', 'TICK', ALL_PASS);
    expect(JSON.stringify(TABLE)).toBe(before);
  });
});
