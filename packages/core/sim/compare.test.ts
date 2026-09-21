import { describe, expect, it } from 'vitest';
import type { Policy } from '../src/index.js';
import { DEFAULT_POLICY } from '../src/index.js';
import {
  AXES,
  compare,
  compareCsv,
  compareText,
  DIGEST_FIELDS,
  type Axis,
  type CompareOptions,
} from './compare.js';
import { run } from './runner.js';
import { WEEKDAY_LUNCH, WEEKEND_PEAK, WEEKEND_PEAK_100, withPolicy } from './scenario.js';

/**
 * 方針の比較（全体プラン 8.2）。
 *
 * **8.2 の 7 項目を、書かれているとおりに振れているか**がいちばん大事である。
 * 軸を 1 つ落としても、値を 1 つ落としても、レポートの結論が欠ける。
 */

/** 小さく速い一式。数字の正しさは `metrics.test.ts` が見る。 */
const SMALL: CompareOptions = { scenario: WEEKDAY_LUNCH, runs: 3, seed: 1 };

function axisOf(key: string): Axis {
  const found = AXES.find((axis) => axis.key === key);
  if (found === undefined) throw new Error(`軸がない: ${key}`);
  return found;
}

/** その軸で振っている値を、指定したキーについて並べる。 */
function valuesOf<K extends keyof Policy>(key: string, field: K): readonly Policy[K][] {
  return axisOf(key).variants.map((variant) => ({ ...DEFAULT_POLICY, ...variant.policy })[field]);
}

// ---------------------------------------------------------------------------

describe('8.2 の 7 項目を覆っているか', () => {
  it('軸が 7 つある', () => {
    expect(AXES.map((axis) => axis.key)).toEqual([
      'allocation',
      'hold',
      'no_show',
      'time_limit',
      'table_order',
      'assign_needs_check',
      'turnover',
    ]);
  });

  /** 8.2 の 1: 厳密 FIFO ／ 純 best fit ／ `fairness_override_min` = 5, 10, 15 */
  it('割当は、厳密 FIFO と純 best fit と 5・10・15 分を振る', () => {
    expect(valuesOf('allocation', 'fairnessOverrideMin')).toEqual([
      10,
      0,
      5,
      15,
      Number.POSITIVE_INFINITY,
    ]);
  });

  /** 8.2 の 2: `hold_min` = 5, 7, 10、延長あり／なし */
  it('ホールドは、5・7・10 分と延長なしを振る', () => {
    expect(valuesOf('hold', 'holdMin')).toEqual([7, 5, 10, 7]);
    expect(valuesOf('hold', 'maxExtensions')).toContain(0);
  });

  /** 8.2 の 3: `cancel` ／ `requeue_once` ／ `requeue_back` */
  it('ノーショーは、3 つの方針をすべて振る', () => {
    expect(valuesOf('no_show', 'noShowPolicy')).toEqual([
      'requeue_once',
      'cancel',
      'requeue_back',
    ]);
  });

  /** 8.2 の 4: `off` ／ `soft` 45, 60 ／ `hard` 60 */
  it('時間上限は、off と soft 45・60 と hard 60 を振る', () => {
    const modes = valuesOf('time_limit', 'timeLimitMode');
    const limits = valuesOf('time_limit', 'timeLimitMin');
    expect(modes).toEqual(['soft', 'off', 'soft', 'hard']);
    expect(limits).toEqual([60, 60, 45, 60]);
  });

  /** 8.2 の 5: 定員昇順のみ ／ 退席確認の新しさ優先を追加 */
  it('席の処理順は、退席確認の新しさの有無を振る', () => {
    const orders = valuesOf('table_order', 'tableOrder');
    expect(orders[0]).toContain('verified_free_desc');
    expect(orders[1]).toEqual(['capacity_asc']);
  });

  /** 8.2 の 6: `assign_needs_check` あり／なし */
  it('確認要の割当は、あり／なしを振る', () => {
    expect(valuesOf('assign_needs_check', 'assignNeedsCheck')).toEqual([true, false]);
  });

  /** 8.2 の 7: `turnover_min` = 0, 1, 2 */
  it('片付けの猶予は、0・1・2 分を振る', () => {
    expect(valuesOf('turnover', 'turnoverMin')).toEqual([0, 1, 2]);
  });
});

describe('軸の宣言', () => {
  /** **先頭は必ず現在の既定値。** 差はここを基準に取るので、ずれると全部ずれる。 */
  it('どの軸も、先頭が既定（差分が空）である', () => {
    for (const axis of AXES) expect(axis.variants[0]?.policy).toEqual({});
  });

  /**
   * **何を最適化したかを言わずに「良くなった」と書かない**ため、軸ごとに
   * 宣言させている（レポートの見出しにそのまま使う）。
   */
  it('どの軸も、決めることと最適化するものを持っている', () => {
    for (const axis of AXES) {
      expect(axis.question.length).toBeGreaterThan(0);
      expect(axis.optimises.length).toBeGreaterThan(0);
      expect(axis.variants.length).toBeGreaterThan(1);
    }
  });

  it('軸の中で、設定の名前が重複していない', () => {
    for (const axis of AXES) {
      const labels = axis.variants.map((variant) => variant.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});

describe('比べ方', () => {
  const single: Axis = axisOf('turnover');

  it('軸と設定の数だけ結果が出る', () => {
    const seen = compare({ ...SMALL, axes: [single] });
    expect(seen.results).toHaveLength(single.variants.length);
    expect(seen.results[0]?.isBaseline).toBe(true);
    expect(seen.results[1]?.isBaseline).toBe(false);
  });

  /** 基準の行は自分自身との差なので、必ず 0 になる。 */
  it('基準の行は、差も標準誤差も 0', () => {
    const base = compare({ ...SMALL, axes: [single] }).results[0];
    for (const field of DIGEST_FIELDS) {
      expect(base?.delta[field]).toBe(0);
      expect(base?.stderr[field]).toBe(0);
    }
  });

  /**
   * **シードごとに引いてから平均する。** 平均どうしを引いても同じ値になるが、
   * 対にしてあることは標準誤差の側に効く（揺らぎが打ち消し合う）。
   */
  it('差は、平均どうしの引き算と一致する', () => {
    const seen = compare({ ...SMALL, axes: [single] });
    const base = seen.results[0];
    const other = seen.results[1];
    if (base === undefined || other === undefined) throw new Error('結果が足りない');
    for (const field of DIGEST_FIELDS) {
      expect(other.delta[field]).toBeCloseTo(other.mean[field] - base.mean[field], 2);
    }
  });

  it('標準誤差は負にならない', () => {
    const seen = compare({ ...SMALL, axes: [single] });
    for (const row of seen.results) {
      for (const field of DIGEST_FIELDS) expect(row.stderr[field]).toBeGreaterThanOrEqual(0);
    }
  });

  it('同じシードなら、同じ結果が出る', () => {
    expect(compare({ ...SMALL, axes: [single] })).toEqual(compare({ ...SMALL, axes: [single] }));
  });

  /** **欠陥が出ないことが、数字を信じてよい条件である。** */
  it('どの設定でも、実装の誤りを示す拒否が出ない', () => {
    expect(compare({ ...SMALL, runs: 2 }).defects).toEqual([]);
  });

  /**
   * **設定を変えれば、何かが動く。** 差がすべて 0 なら、設定が効いていないか、
   * シナリオがその軸を踏んでいない（空回りの検査）。
   *
   * `table_order` だけは外してある。**使う席は変わるが、測れる結果が変わらない**
   * ことが分かっているためで、その事実は次のテストが押さえる。
   */
  it('席の処理順を除くすべての軸で、既定と違う設定は何かを動かす', () => {
    const seen = compare({ ...SMALL, runs: 5 });
    for (const axis of AXES.filter((item) => item.key !== 'table_order')) {
      const others = seen.results.filter((row) => row.axis === axis.key && !row.isBaseline);
      const moved = others.some((row) => DIGEST_FIELDS.some((field) => row.delta[field] !== 0));
      expect(moved, `${axis.key} で何も動かなかった`).toBe(true);
    }
  });

  /**
   * **席の処理順は、使う席を変えるが結果を変えない**（PR 15 で分かった）。
   *
   * 30 卓の施設では呼び出し先の 71.9% が変わるのに、事故の件数も座れた組も
   * 動かない。**混んだ施設では、避けた席もいずれ案内される。** 無断利用されて
   * いる席を後回しにしても、事故が先延ばしになるだけで件数は変わらない。
   *
   * **この検査は、効いていないことのほうを固定する。** 模型を変えて効くように
   * なったら落ちるので、そのとき結論を見直せる。
   */
  it('席の処理順は、使う席を変えるが結果を変えない', () => {
    const base = WEEKEND_PEAK_100;
    const only = withPolicy(base, { ...base.policy, tableOrder: ['capacity_asc'] });
    const differs = [1, 2, 3].every(
      (seed) =>
        JSON.stringify(run({ scenario: base, seed }).events) !==
        JSON.stringify(run({ scenario: only, seed }).events),
    );
    expect(differs, '使う席すら変わっていない').toBe(true);

    // 実証実験の区画（8 卓）では、結果がきっかり一致する。
    const seen = compare({ scenario: WEEKEND_PEAK, runs: 20, seed: 1, axes: [axisOf('table_order')] });
    expect(seen.results[1]?.delta.seatTaken).toBe(0);
    expect(seen.results[1]?.delta.seated).toBe(0);
  });
});

describe('見せ方', () => {
  it('CSV は、項目ごとに平均・差・標準誤差を並べる', () => {
    const csv = compareCsv(compare({ ...SMALL, axes: [axisOf('turnover')] }));
    const head = csv.split('\n')[0] ?? '';
    for (const field of DIGEST_FIELDS) {
      expect(head).toContain(`,${field},`);
      expect(head).toContain(`d_${field}`);
      expect(head).toContain(`se_${field}`);
    }
    expect(csv.trimEnd().split('\n')).toHaveLength(1 + axisOf('turnover').variants.length);
  });

  it('画面の表は、軸の問いと最適化するものを見出しに出す', () => {
    const text = compareText(compare({ ...SMALL, axes: [axisOf('turnover')] }));
    expect(text).toContain(axisOf('turnover').question);
    expect(text).toContain(axisOf('turnover').optimises);
  });

  /** **揺らぎと区別できない差は括弧に入れる。** 読む人が取り違えないように。 */
  it('標準誤差の 2 倍に届かない差は、括弧に入れて出す', () => {
    const text = compareText(compare({ ...SMALL, runs: 3, axes: [axisOf('turnover')] }));
    expect(text).toMatch(/\([+-]\d/);
  });
});
