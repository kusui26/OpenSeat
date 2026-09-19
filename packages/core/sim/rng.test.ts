import { describe, expect, it } from 'vitest';
import { createRng, hashName, streamFor, type Rng } from './rng.js';

function take(rng: Rng, count: number): readonly number[] {
  return Array.from({ length: count }, () => rng.next());
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

describe('再現できること（これが唯一の要件）', () => {
  it('同じシードからは同じ列が出る', () => {
    expect(take(createRng(42), 50)).toEqual(take(createRng(42), 50));
  });

  it('別のシードからは別の列が出る', () => {
    expect(take(createRng(1), 20)).not.toEqual(take(createRng(2), 20));
  });

  it('近いシードでも無関係な列になる（種を広げているため）', () => {
    const a = take(createRng(1000), 200);
    const b = take(createRng(1001), 200);
    const shared = a.filter((value, index) => value === b[index]);
    expect(shared).toEqual([]);
  });

  it('シードが 0 でも動く', () => {
    expect(take(createRng(0), 10)).toEqual(take(createRng(0), 10));
  });

  it('負のシードでも動く', () => {
    expect(take(createRng(-7), 10)).toEqual(take(createRng(-7), 10));
  });
});

describe('値の範囲と散らばり', () => {
  const values = take(createRng(2024), 20_000);

  it('0 以上 1 未満に収まる', () => {
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it('平均が 0.5 に近い', () => {
    expect(mean(values)).toBeCloseTo(0.5, 2);
  });

  it('10 等分した各区間に、おおむね均等に入る', () => {
    const bins = new Array<number>(10).fill(0);
    for (const value of values) {
      const index = Math.min(9, Math.floor(value * 10));
      bins[index] = (bins[index] ?? 0) + 1;
    }
    const expected = values.length / 10;
    expect(bins.every((count) => Math.abs(count - expected) < expected * 0.1)).toBe(true);
  });

  it('同じ値が続けて出ない（状態が動いている）', () => {
    const repeated = values.filter((value, index) => index > 0 && value === values[index - 1]);
    expect(repeated).toEqual([]);
  });
});

describe('目的ごとに独立した流れ（共通乱数）', () => {
  it('同じ (シード, 名前, 番号) からは同じ列が出る', () => {
    expect(take(streamFor(7, 'party', 3), 20)).toEqual(take(streamFor(7, 'party', 3), 20));
  });

  it('名前が違えば別の列になる', () => {
    expect(take(streamFor(7, 'party', 0), 20)).not.toEqual(take(streamFor(7, 'arrivals', 0), 20));
  });

  it('番号が違えば別の列になる', () => {
    expect(take(streamFor(7, 'party', 0), 20)).not.toEqual(take(streamFor(7, 'party', 1), 20));
  });

  /**
   * **これが流れを分ける理由。** ある目的で乱数を引く回数が変わっても、
   * ほかの目的の列は 1 つも動かない。方針を取り替えて比べるとき、到着や人数が
   * 同じままであることがここに懸かっている（8.2）。
   */
  it('1 つの流れをいくら引いても、別の流れは動かない', () => {
    const before = take(streamFor(7, 'arrivals', 0), 10);
    const noisy = streamFor(7, 'party', 0);
    take(noisy, 1000);
    expect(take(streamFor(7, 'arrivals', 0), 10)).toEqual(before);
  });

  it('連続する番号の流れどうしが似ていない', () => {
    const first = take(streamFor(7, 'party', 100), 50);
    const second = take(streamFor(7, 'party', 101), 50);
    expect(first.filter((value, index) => value === second[index])).toEqual([]);
  });

  it('多数の流れを作っても、平均が 0.5 から離れない', () => {
    const firsts = Array.from({ length: 2000 }, (_unused, index) =>
      streamFor(99, 'party', index).next(),
    );
    expect(mean(firsts)).toBeCloseTo(0.5, 1);
  });
});

describe('名前の畳み込み', () => {
  it('同じ名前からは同じ数が出る', () => {
    expect(hashName('arrivals')).toBe(hashName('arrivals'));
  });

  it('違う名前からは違う数が出る', () => {
    expect(hashName('arrivals')).not.toBe(hashName('party'));
  });

  it('1 文字違いでも離れた数になる', () => {
    expect(Math.abs(hashName('party') - hashName('parry'))).toBeGreaterThan(1000);
  });

  it('空の名前でも数になる', () => {
    expect(Number.isInteger(hashName(''))).toBe(true);
  });
});
