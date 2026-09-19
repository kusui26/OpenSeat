import { describe, expect, it } from 'vitest';
import { minutes, type DurationMs } from '../src/index.js';
import {
  arrivalTimes,
  arrivalWindow,
  bernoulli,
  discrete,
  logNormal,
  rateAt,
  sigmaFromP90,
  standardNormal,
  type RateBucket,
  type Weighted,
} from './distributions.js';
import { createRng, type Rng } from './rng.js';

const SAMPLES = 40_000;

function draws<T>(count: number, rng: Rng, draw: (rng: Rng) => T): readonly T[] {
  return Array.from({ length: count }, () => draw(rng));
}

function quantile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] ?? 0;
}

function shareOf<T>(values: readonly T[], target: T): number {
  return values.filter((value) => value === target).length / values.length;
}

/**
 * 割合が指定に一致することを、**標本誤差を見込んで**確かめる。
 *
 * 有限回の試行なので、正しい実装でも指定からはずれる。許容幅を桁数で決めると、
 * 期待値や回数を変えたときに「たまたま落ちる」テストになる。二項分布の標準誤差
 * の 4 倍（両側でおよそ 99.99%）までを許すことで、実装の誤りだけを捕まえる。
 */
function expectShare(actual: number, expected: number, samples: number): void {
  const standardError: number = Math.sqrt((expected * (1 - expected)) / samples);
  expect(Math.abs(actual - expected)).toBeLessThan(4 * standardError);
}

describe('離散分布（8.1「人数分布」）', () => {
  /** 8.1 の指定をそのまま書き写す。**この表が仕様との照合点である。** */
  const PARTY_SIZES: readonly Weighted<number>[] = [
    { value: 1, weight: 25 },
    { value: 2, weight: 40 },
    { value: 3, weight: 15 },
    { value: 4, weight: 15 },
    { value: 5, weight: 5 },
  ];

  const sizes = draws(SAMPLES, createRng(11), (rng) => discrete(rng, PARTY_SIZES) ?? 0);

  it.each(PARTY_SIZES)('$value 名がおよそ $weight% になる', ({ value, weight }) => {
    expectShare(shareOf(sizes, value), weight / 100, SAMPLES);
  });

  it('指定に無い値は出ない', () => {
    expect(sizes.every((size) => size >= 1 && size <= 5)).toBe(true);
  });

  it('重みは百分率でなくてもよい（合計で正規化する）', () => {
    const halved = PARTY_SIZES.map((choice) => ({ ...choice, weight: choice.weight / 2 }));
    const scaled = draws(SAMPLES, createRng(11), (rng) => discrete(rng, halved) ?? 0);
    expectShare(shareOf(scaled, 2), 0.4, SAMPLES);
  });

  it('重み 0 の項目は選ばれない', () => {
    const withZero: readonly Weighted<string>[] = [
      { value: 'a', weight: 1 },
      { value: 'b', weight: 0 },
    ];
    const picked = draws(500, createRng(3), (rng) => discrete(rng, withZero));
    expect(picked.every((value) => value === 'a')).toBe(true);
  });

  it('候補が空なら null', () => {
    expect(discrete(createRng(1), [])).toBeNull();
  });

  it('重みがすべて 0 なら null', () => {
    expect(discrete(createRng(1), [{ value: 'a', weight: 0 }])).toBeNull();
  });
});

describe('正規分布と対数正規分布', () => {
  it('標準正規分布の平均が 0、標準偏差が 1 に近い', () => {
    const values = draws(SAMPLES, createRng(5), standardNormal);
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
      values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
    expect(average).toBeCloseTo(0, 1);
    expect(Math.sqrt(variance)).toBeCloseTo(1, 1);
  });

  /** 8.1「滞在時間: 中央値 30 分、σ=0.4」。 */
  it('滞在時間の中央値が 30 分になる', () => {
    const median: DurationMs = minutes(30);
    const values = draws(SAMPLES, createRng(6), (rng) => logNormal(rng, median, 0.4));
    expect(quantile(values, 0.5) / median).toBeCloseTo(1, 1);
  });

  it('対数正規分布は負にならない', () => {
    const values = draws(5_000, createRng(6), (rng) => logNormal(rng, minutes(30), 0.4));
    expect(values.every((value) => value > 0)).toBe(true);
  });

  it('σ が 0 なら中央値そのものが出る', () => {
    expect(logNormal(createRng(6), minutes(30), 0)).toBe(minutes(30));
  });

  /** 8.1「呼び出し → 着席: 中央値 2 分、p90 6 分」を σ に変換して使う。 */
  describe('中央値と p90 から σ を導く', () => {
    const median: DurationMs = minutes(2);
    const p90: DurationMs = minutes(6);
    const sigma = sigmaFromP90(median, p90);

    it('導いた σ で引くと、中央値が 2 分になる', () => {
      const values = draws(SAMPLES, createRng(8), (rng) => logNormal(rng, median, sigma));
      expect(quantile(values, 0.5) / median).toBeCloseTo(1, 1);
    });

    it('導いた σ で引くと、p90 が 6 分になる', () => {
      const values = draws(SAMPLES, createRng(8), (rng) => logNormal(rng, median, sigma));
      expect(quantile(values, 0.9) / p90).toBeCloseTo(1, 1);
    });

    it('p90 が中央値以下なら、ばらつきは 0 とみなす', () => {
      expect(sigmaFromP90(minutes(5), minutes(5))).toBe(0);
      expect(sigmaFromP90(minutes(5), minutes(3))).toBe(0);
    });
  });
});

describe('ベルヌーイ（8.1「ノーショー率」「退席申告率」）', () => {
  it.each([0.08, 0.15, 0.6])('確率 %f がおよそ再現される', (probability) => {
    const values = draws(SAMPLES, createRng(9), (rng) => bernoulli(rng, probability));
    expectShare(shareOf(values, true), probability, SAMPLES);
  });

  it('確率 0 なら決して真にならない', () => {
    expect(draws(1_000, createRng(9), (rng) => bernoulli(rng, 0)).some((value) => value)).toBe(false);
  });

  it('確率 1 なら必ず真になる', () => {
    expect(draws(1_000, createRng(9), (rng) => bernoulli(rng, 1)).every((value) => value)).toBe(true);
  });
});

describe('到着（8.1「非定常ポアソン過程」）', () => {
  /** 15 分刻み、4 区間で 1 時間。 */
  const BUCKETS: readonly RateBucket[] = [
    { from: 0, perHour: 20 },
    { from: minutes(15), perHour: 60 },
    { from: minutes(30), perHour: 60 },
    { from: minutes(45), perHour: 20 },
  ];

  it('区間の境目で率が切り替わる', () => {
    expect(rateAt(BUCKETS, minutes(14))).toBe(20);
    expect(rateAt(BUCKETS, minutes(15))).toBe(60);
    expect(rateAt(BUCKETS, minutes(44))).toBe(60);
    expect(rateAt(BUCKETS, minutes(45))).toBe(20);
  });

  it('最初の区間より前は 0', () => {
    expect(rateAt([{ from: minutes(10), perHour: 30 }], minutes(5))).toBe(0);
  });

  it('定義域は最後の区間の終わりまで', () => {
    expect(arrivalWindow(BUCKETS)).toBe(minutes(60));
    expect(arrivalWindow([])).toBe(0);
  });

  it('到着時刻は増える順に並ぶ', () => {
    const times = arrivalTimes(createRng(21), BUCKETS, minutes(60));
    expect(times.every((time, index) => index === 0 || time >= (times[index - 1] ?? 0))).toBe(true);
  });

  it('到着時刻は定義域の中に収まる', () => {
    const times = arrivalTimes(createRng(21), BUCKETS, minutes(60));
    expect(times.every((time) => time >= 0 && time < minutes(60))).toBe(true);
  });

  /**
   * 1 時間あたりの平均が指定に一致する。
   *
   * 区間の平均は (20 + 60 + 60 + 20) / 4 = 40 組/時。1 時間ぶんを 300 回
   * 走らせて平均を見る。ポアソン過程なので 1 回ごとのばらつきは大きい。
   */
  it('平均の到着組数が、指定した率に一致する', () => {
    const counts = Array.from(
      { length: 300 },
      (_unused, seed) => arrivalTimes(createRng(seed), BUCKETS, minutes(60)).length,
    );
    const average = counts.reduce((sum, count) => sum + count, 0) / counts.length;
    expect(average).toBeGreaterThan(38);
    expect(average).toBeLessThan(42);
  });

  it('混んでいる区間のほうが、到着が多い', () => {
    const times = arrivalTimes(createRng(33), BUCKETS, minutes(60));
    const quiet = times.filter((time) => time < minutes(15)).length;
    const busy = times.filter((time) => time >= minutes(15) && time < minutes(30)).length;
    expect(busy).toBeGreaterThan(quiet);
  });

  it('率がすべて 0 なら到着しない', () => {
    expect(arrivalTimes(createRng(1), [{ from: 0, perHour: 0 }], minutes(60))).toEqual([]);
  });

  it('区間が無ければ到着しない', () => {
    expect(arrivalTimes(createRng(1), [], minutes(60))).toEqual([]);
  });

  it('同じシードからは同じ到着列が出る', () => {
    expect(arrivalTimes(createRng(4), BUCKETS, minutes(60))).toEqual(
      arrivalTimes(createRng(4), BUCKETS, minutes(60)),
    );
  });
});
