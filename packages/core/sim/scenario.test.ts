import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, minutes } from '../src/index.js';
import { arrivalWindow, rateAt } from './distributions.js';
import {
  CHECKOUT_REPORT_RATE,
  NO_SHOW,
  PARTY_SIZES,
  SCENARIOS,
  STAY,
  TABLES_100,
  TABLES_26,
  TABLES_50,
  WALK,
  WEEKDAY_ARRIVALS,
  WEEKDAY_LUNCH,
  WEEKEND_ARRIVALS,
  WEEKEND_OVERLOAD,
  WEEKEND_PEAK,
  WEEKEND_PEAK_100,
  scaleArrivals,
  seatCount,
  shareOfVenue,
  withCheckoutReportRate,
  withPolicy,
  type Scenario,
} from './scenario.js';

/**
 * 全体プラン 8.1 の表と 1 対 1 で照合する。
 *
 * 8.1 の数字は現地観察で置き換わる。そのときにどこを直すべきかが、このテストの
 * 一覧を見れば分かるようにしてある。
 */

function averageRate(scenario: Scenario): number {
  const rates = scenario.arrivals.map((bucket) => bucket.perHour);
  return rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
}

describe('席構成（8.1「席構成」の行）', () => {
  it('実証実験の候補区画は 2 名席×4、4 名席×3、6 名席×1 で 26 席', () => {
    expect(TABLES_26).toEqual([
      { capacity: 2, count: 4 },
      { capacity: 4, count: 3 },
      { capacity: 6, count: 1 },
    ]);
    expect(seatCount(TABLES_26)).toBe(26);
  });

  it('比較用の席構成はちょうど 50 席と 100 席', () => {
    expect(seatCount(TABLES_50)).toBe(50);
    expect(seatCount(TABLES_100)).toBe(100);
  });

  it.each([[TABLES_26], [TABLES_50], [TABLES_100]])('どの構成も 3 種類の席を持つ', (tables) => {
    expect(tables.map((spec) => spec.capacity)).toEqual([2, 4, 6]);
    expect(tables.every((spec) => spec.count > 0)).toBe(true);
  });

  it('施設全体（100 席）に対する割合が席数から決まる', () => {
    expect(shareOfVenue(TABLES_26)).toBeCloseTo(0.26, 5);
    expect(shareOfVenue(TABLES_50)).toBeCloseTo(0.5, 5);
    expect(shareOfVenue(TABLES_100)).toBe(1);
  });
});

describe('人数分布（8.1「人数分布」の行）', () => {
  it('重みの合計が 100 になる', () => {
    expect(PARTY_SIZES.reduce((sum, choice) => sum + choice.weight, 0)).toBe(100);
  });

  it.each([
    [1, 25],
    [2, 40],
    [3, 15],
    [4, 15],
  ])('%i 名が %i%%', (value, weight) => {
    expect(PARTY_SIZES.find((choice) => choice.value === value)?.weight).toBe(weight);
  });

  /** 8.1 は「5 名以上 5%」。6 名席を使う組を出すために 2 つに分けてある。 */
  it('5 名以上を合わせると 5%（5 名 3%・6 名 2% に分けてある）', () => {
    const large = PARTY_SIZES.filter((choice) => choice.value >= 5);
    expect(large.reduce((sum, choice) => sum + choice.weight, 0)).toBe(5);
    expect(large.map((choice) => choice.value)).toEqual([5, 6]);
  });

  it('いちばん大きい組は、いちばん大きい席に収まる', () => {
    const largest = Math.max(...PARTY_SIZES.map((choice) => choice.value));
    expect(largest).toBe(Math.max(...TABLES_26.map((spec) => spec.capacity)));
  });
});

describe('振る舞いのモデル（8.1 の残りの行）', () => {
  it('滞在時間は中央値 30 分・σ=0.4、4 名以上は中央値 40 分', () => {
    expect(STAY).toEqual({
      medianMin: 30,
      largePartyFrom: 4,
      largePartyMedianMin: 40,
      sigma: 0.4,
    });
  });

  it('呼び出しから着席までは中央値 2 分・p90 6 分', () => {
    expect(WALK).toEqual({ medianMin: 2, p90Min: 6 });
  });

  it('ノーショーは基礎 8%、待ち 20 分超で 15%', () => {
    expect(NO_SHOW).toEqual({ baseRate: 0.08, longWaitFromMin: 20, longWaitRate: 0.15 });
  });

  it('退席の申告率は 60%', () => {
    expect(CHECKOUT_REPORT_RATE).toBe(0.6);
  });
});

describe('到着率（8.1「到着」の行）', () => {
  it('平日昼は平均 20 組/時のあたり', () => {
    expect(averageRate(WEEKDAY_LUNCH)).toBeGreaterThan(17);
    expect(averageRate(WEEKDAY_LUNCH)).toBeLessThan(22);
  });

  it('平日昼は 2 時間ぶん（15 分刻みで 8 区間）', () => {
    expect(WEEKDAY_ARRIVALS).toHaveLength(8);
    expect(arrivalWindow(WEEKDAY_ARRIVALS)).toBe(minutes(120));
  });

  it('土日昼は 3 時間半ぶん（15 分刻みで 14 区間）', () => {
    expect(WEEKEND_ARRIVALS).toHaveLength(14);
    expect(arrivalWindow(WEEKEND_ARRIVALS)).toBe(minutes(210));
  });

  it('土日昼のピーク帯（11:30〜13:30）が 60 組/時以上になる', () => {
    // 11:00 を 0 分としているので、11:30 は 30 分、13:30 は 150 分。
    const peak = WEEKEND_ARRIVALS.filter(
      (bucket) => bucket.from >= minutes(30) && bucket.from < minutes(150),
    );
    expect(peak.every((bucket) => bucket.perHour >= 60)).toBe(true);
  });

  it('土日昼のいちばん高い率が 90 組/時', () => {
    expect(Math.max(...WEEKEND_ARRIVALS.map((bucket) => bucket.perHour))).toBe(90);
  });

  it('率を割合で減らせる', () => {
    const halved = scaleArrivals(WEEKEND_ARRIVALS, 0.5);
    expect(rateAt(halved, minutes(60))).toBe(rateAt(WEEKEND_ARRIVALS, minutes(60)) / 2);
    expect(arrivalWindow(halved)).toBe(arrivalWindow(WEEKEND_ARRIVALS));
  });
});

describe('シナリオの組み立て', () => {
  const all: readonly Scenario[] = Object.values(SCENARIOS);

  it.each(all)('$name の受付時間が到着率の定義域と一致する', (scenario) => {
    expect(scenario.joinOpenFor).toBe(arrivalWindow(scenario.arrivals));
  });

  it.each(all)('$name は既定の運用パラメータを使う', (scenario) => {
    expect(scenario.policy).toBe(DEFAULT_POLICY);
  });

  it('名前の一覧と、それぞれのシナリオの名前が一致する', () => {
    for (const [key, scenario] of Object.entries(SCENARIOS)) {
      expect(scenario.name).toBe(key);
    }
  });

  /**
   * **8.1 の到着率は施設全体のもの。** 区画のシナリオでは席数の割合まで減らす。
   * 減らさないと 26 席に 4 倍の負荷がかかる（`weekend-overload` で見られる）。
   */
  it('区画のシナリオは、施設全体の率を席数の割合まで減らしてある', () => {
    expect(averageRate(WEEKEND_PEAK)).toBeCloseTo(averageRate(WEEKEND_PEAK_100) * 0.26, 5);
  });

  it('100 席のシナリオは 8.1 の率をそのまま使う', () => {
    expect(WEEKEND_PEAK_100.arrivals).toBe(WEEKEND_ARRIVALS);
  });

  it('過負荷のシナリオは、26 席に施設全体の率をぶつける', () => {
    expect(WEEKEND_OVERLOAD.tables).toBe(TABLES_26);
    expect(WEEKEND_OVERLOAD.arrivals).toBe(WEEKEND_ARRIVALS);
  });
});

describe('差し替え（8.2 の比較で使う）', () => {
  it('運用パラメータを差し替えられる', () => {
    const strict = withPolicy(WEEKEND_PEAK, { ...DEFAULT_POLICY, noShowPolicy: 'cancel' });
    expect(strict.policy.noShowPolicy).toBe('cancel');
    expect(strict.arrivals).toBe(WEEKEND_PEAK.arrivals);
  });

  it('退席の申告率を差し替えられる', () => {
    expect(withCheckoutReportRate(WEEKEND_PEAK, 1).checkoutReportRate).toBe(1);
  });

  it('差し替えても元のシナリオは変わらない', () => {
    withPolicy(WEEKEND_PEAK, { ...DEFAULT_POLICY, holdMin: 99 });
    expect(WEEKEND_PEAK.policy).toBe(DEFAULT_POLICY);
  });
});
