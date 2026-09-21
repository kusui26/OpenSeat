import { describe, expect, it } from 'vitest';
import { minutes } from '../src/index.js';
import { runBaseline, SCAN_RATE_PER_MIN, type BaselineResult } from './baseline.js';
import { collect, collectBaseline } from './metrics.js';
import { plannedParties, run } from './runner.js';
import {
  scaleArrivals,
  TABLES_26,
  TABLES_100,
  WEEKEND_ARRIVALS,
  WEEKEND_PEAK,
  WEEKEND_PEAK_100,
  type Scenario,
} from './scenario.js';

/**
 * 自由席のベースライン（全体プラン 8.1 の最終行、8.3）。
 *
 * **比較の相手として信用できるか**を見る。速いか遅いかではなく、(1) 同じ人が
 * 同じ時刻に来ているか、(2) 混むほど探索が伸びるか、(3) 極端な場面で壊れないか。
 */

/** 揺らぎをならすためのシード。1 回だけだと、たまたまの差を性質と読み違える。 */
const SEEDS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 卓が 1 つも無い施設。誰も座れない。 */
const NO_TABLES: Scenario = { ...WEEKEND_PEAK, name: 'no-tables', tables: [] };

/** 卓が 1 つだけの施設。**満席のまま動かない場面を作る。** */
const ONE_TABLE: Scenario = {
  ...WEEKEND_PEAK,
  name: 'one-table',
  tables: [{ capacity: 6, count: 1 }],
};

function seatedShare(result: BaselineResult): number {
  return result.searches.filter((search) => search.seatedAt !== null).length / result.searches.length;
}

// ---------------------------------------------------------------------------

describe('比較の相手として成り立っているか', () => {
  /**
   * **同じ人が、同じ時刻に、同じ人数で来る。**
   *
   * ここが揃っていないと、差が「席の決まり方」の差なのか「来た人」の差なのか
   * 分からなくなる（共通乱数。`rng.ts`）。
   */
  it('OpenSeat の側とまったく同じ組が来る', () => {
    const expected = plannedParties(WEEKEND_PEAK, 3);
    const seen = runBaseline({ scenario: WEEKEND_PEAK, seed: 3 });
    expect(seen.searches.map((search) => search.ticketId)).toEqual(
      expected.map((party) => party.ticketId),
    );
    expect(seen.searches.map((search) => search.arriveAt)).toEqual(
      expected.map((party) => party.arriveAt),
    );
    expect(seen.searches.map((search) => search.partySize)).toEqual(
      expected.map((party) => party.partySize),
    );
  });

  it('同じシードなら、同じ結果が出る', () => {
    const first = runBaseline({ scenario: WEEKEND_PEAK, seed: 5 });
    const again = runBaseline({ scenario: WEEKEND_PEAK, seed: 5 });
    expect(again).toEqual(first);
  });

  /**
   * **諦める人が両方にいる。** OpenSeat の側には抜け道が 2 つ（目安を見てやめる、
   * 呼ばれても来ない）あり、自由席の側に 1 つも無いと、「座れた組」の差が
   * ほとんど抜け道の有無で決まってしまう。
   */
  it('自由席でも、待ったすえに諦める組が出る', () => {
    const seen = collectBaseline(runBaseline({ scenario: WEEKEND_PEAK, seed: 3 }));
    expect(seen.gaveUp).toBeGreaterThan(0);
    expect(seen.arrived).toBe(seen.seated + seen.gaveUp + seen.stillSearching);
  });

  /** **順番という仕掛けが無いので、先を越されるのが当たり前になる。** */
  it('OpenSeat より、先を越される回数がずっと多い', () => {
    const own = collect(run({ scenario: WEEKEND_PEAK, seed: 3 }));
    const free = collectBaseline(runBaseline({ scenario: WEEKEND_PEAK, seed: 3 }));
    expect(free.fairness.overtakenMean).toBeGreaterThan(own.fairness.overtakenMean * 3);
    expect(free.fairness.overtakenMax).toBeGreaterThan(own.fairness.overtakenMax);
  });
});

describe('探すという行為', () => {
  /** 収まらない卓には座らない。1 名は 6 名席に座るが、その逆は起きない。 */
  it('定員を超える組は、その卓に座らない', () => {
    const seen = runBaseline({ scenario: ONE_TABLE, seed: 4 });
    const seated = seen.searches.filter((search) => search.seatedAt !== null);
    expect(seated.length).toBeGreaterThan(0);
    expect(seated.every((search) => search.partySize <= 6)).toBe(true);
  });

  /**
   * **混むほど探索が伸びる。** 8.1 の「占有率 95% 超で探索 5〜15 分」は、
   * この単調性を言い換えたものである。到着率を上げれば占有率が上がる。
   */
  it('到着が増えるほど、席を見つけるまでが長くなる', () => {
    const quiet: Scenario = {
      ...WEEKEND_PEAK_100,
      arrivals: scaleArrivals(WEEKEND_PEAK_100.arrivals, 0.4),
    };
    const busy: Scenario = {
      ...WEEKEND_PEAK_100,
      arrivals: scaleArrivals(WEEKEND_PEAK_100.arrivals, 1.2),
    };
    const at = (scenario: Scenario): number =>
      collectBaseline(runBaseline({ scenario, seed: 9 })).search.meanMin;
    expect(at(busy)).toBeGreaterThan(at(quiet) * 2);
  });

  /**
   * **混み具合が同じなら、フロアの広さによらず探索時間は変わらない。**
   *
   * 1 回覗いて当たる見込みは「空いている卓 ÷ 全部の卓」＝ 1 − 占有率で、
   * 卓数が約分されて消える。**この性質があるから、8.1 の校正（占有率 95% 超で
   * 5〜15 分）を 26 席の実証区画にそのまま当てはめられる。**
   *
   * 逆に言えば「広いフロアほど歩く距離が延びる」ことは入れていない。入れるなら
   * 現地観察で測ってからにする（8.1 の最終行、8.5）。
   */
  it('混み具合が同じなら、卓数が変わっても探索時間はほぼ同じ', () => {
    const scaled = (tables: typeof TABLES_100, share: number): Scenario => ({
      ...WEEKEND_PEAK_100,
      tables,
      arrivals: scaleArrivals(WEEKEND_ARRIVALS, share),
    });
    const at = (scenario: Scenario): number =>
      mean(SEEDS.map((seed) => collectBaseline(runBaseline({ scenario, seed })).search.meanMin));

    const small: number = at(scaled(TABLES_26, 8 / 30));
    const large: number = at(scaled(TABLES_100, 1));
    expect(Math.abs(small - large) / large).toBeLessThan(0.15);
  });

  /** 見て回る速さを上げれば、そのぶん早く見つかる。 */
  it('見て回る速さを上げると、探索が短くなる', () => {
    const slow = collectBaseline(
      runBaseline({ scenario: WEEKEND_PEAK_100, seed: 9, scanRatePerMin: SCAN_RATE_PER_MIN / 4 }),
    );
    const fast = collectBaseline(
      runBaseline({ scenario: WEEKEND_PEAK_100, seed: 9, scanRatePerMin: SCAN_RATE_PER_MIN * 4 }),
    );
    expect(fast.search.meanMin).toBeLessThan(slow.search.meanMin);
  });
});

describe('極端な場面で壊れないか', () => {
  /** **プランの完了条件。** 誰も座れなくても、数字が発散しない。 */
  it('卓が 1 つも無くても、探索時間は見届けた時間を超えない', () => {
    const result = runBaseline({ scenario: NO_TABLES, seed: 1 });
    const seen = collectBaseline(result);
    expect(seen.seated).toBe(0);
    expect(seen.search.meanMin).toBe(0);
    expect(seen.occupiedShare).toBe(0);
    expect(seen.arrived).toBe(seen.gaveUp + seen.stillSearching);
  });

  /** 満席が続いても、座れた組の探索時間は見届けた時間の中に収まる。 */
  it('ずっと満席でも、探索時間は見届けた時間の中に収まる', () => {
    const result = runBaseline({ scenario: ONE_TABLE, seed: 1 });
    const first: number = result.searches[0]?.arriveAt ?? result.endedAt;
    const window: number = (result.endedAt - first) / minutes(1);
    expect(collectBaseline(result).search.maxMin).toBeLessThanOrEqual(window);
    expect(seatedShare(result)).toBeLessThan(0.2);
  });

  it('卓が空けば、次の組がそこを使える', () => {
    const result = runBaseline({ scenario: ONE_TABLE, seed: 1 });
    // 1 卓しか無いのに複数の組が座れているなら、使い回されている。
    expect(result.searches.filter((search) => search.seatedAt !== null).length).toBeGreaterThan(1);
  });

  /** 使われた時間は、卓 × 見届けた時間を超えない。 */
  it('使われた時間が、ありうる上限を超えない', () => {
    const result = runBaseline({ scenario: WEEKEND_PEAK, seed: 2 });
    expect(result.occupiedMs).toBeLessThanOrEqual(result.tableMs);
    expect(result.seatedPersonMs).toBeLessThanOrEqual(result.occupiedCapacityMs);
  });
});
