import { describe, expect, it } from 'vitest';
import {
  COLUMNS,
  DEFAULT_OPTIONS,
  MAX_RUNS,
  METRIC_TOPICS,
  parseArgs,
  runBatch,
  summaryOf,
  toCsv,
  USAGE,
  type Batch,
  type CliOptions,
} from './cli.js';
import { PARTY_SIZES_REPORTED } from './metrics.js';
import { toHtml } from './report.js';
import { SCENARIO_NAMES } from './scenario.js';

/**
 * CLI（全体プラン 8.4）。
 *
 * **副作用が無いので、丸ごと試せる。** ファイルに書くのは `main.ts` の仕事で、
 * ここで見るのは「引数を正しく読むか」「列が 8.3 を覆っているか」
 * 「同じシードで同じものが出るか」の 3 つである。
 */

/** 小さく速い一式。中身の正しさは `metrics.test.ts` が見る。 */
const SMALL: CliOptions = { ...DEFAULT_OPTIONS, scenario: 'weekday-lunch', runs: 2, seed: 1 };

function batch(patch: Partial<CliOptions> = {}): Batch {
  return runBatch({ ...SMALL, ...patch });
}

// ---------------------------------------------------------------------------

describe('引数の読み取り', () => {
  it('何も指定しなければ既定で動く', () => {
    const seen = parseArgs([]);
    expect(seen.ok && seen.value).toEqual(DEFAULT_OPTIONS);
  });

  it('シナリオ・回数・シード・書き出し先を受け取る', () => {
    const seen = parseArgs([
      '--scenario', 'weekend-overload',
      '--runs', '50',
      '--seed', '7',
      '--out', 'a.csv',
      '--html', 'a.html',
      '--no-baseline',
    ]);
    expect(seen.ok && seen.value).toEqual({
      scenario: 'weekend-overload',
      runs: 50,
      seed: 7,
      out: 'a.csv',
      html: 'a.html',
      baseline: false,
    });
  });

  /**
   * **打ち間違いを受け流さない。**
   *
   * 黙って無視すると、既定値で回った結果を「指定した設定の結果」だと
   * 思い込むことになる。
   */
  it('知らない指定は失敗にする', () => {
    const seen = parseArgs(['--polcy', 'default']);
    expect(seen.ok).toBe(false);
    expect(!seen.ok && seen.error).toContain('--polcy');
  });

  it('知らないシナリオは、選べる名前を添えて断る', () => {
    const seen = parseArgs(['--scenario', 'monday']);
    expect(!seen.ok && seen.error).toContain('weekend-peak');
  });

  it('値の無い指定を断る', () => {
    expect(parseArgs(['--runs']).ok).toBe(false);
  });

  it('整数でない回数、範囲の外の回数を断る', () => {
    expect(parseArgs(['--runs', '0']).ok).toBe(false);
    expect(parseArgs(['--runs', '2.5']).ok).toBe(false);
    expect(parseArgs(['--runs', 'たくさん']).ok).toBe(false);
    expect(parseArgs(['--runs', String(MAX_RUNS + 1)]).ok).toBe(false);
  });

  it('案内には、選べるシナリオがすべて載っている', () => {
    for (const name of SCENARIO_NAMES) expect(USAGE).toContain(name);
  });
});

describe('CSV', () => {
  /**
   * **すべての列が 8.3 の項目に属し、どの項目にも列がある。**
   *
   * 指標を足したときに「8.3 のどれを測ったのか」を言えなくなるのを防ぐ。
   * 逆に、項目に列が 1 つも無ければ、その指標を測り忘れている。
   */
  it('列が 8.3 の項目を過不足なく覆っている', () => {
    const topics = new Set(COLUMNS.map((column) => column.topic));
    for (const topic of Object.keys(METRIC_TOPICS)) expect(topics).toContain(topic);
    for (const column of COLUMNS) expect(METRIC_TOPICS).toHaveProperty(column.topic);
  });

  it('列の名前が重複していない', () => {
    expect(new Set(COLUMNS.map((column) => column.key)).size).toBe(COLUMNS.length);
  });

  /** 8.3 の「2 名組と 4 名組の差を必ず見る」。1〜6 名ぶんの列が要る。 */
  it('人数別の列が 1〜6 名ぶんある', () => {
    for (const size of PARTY_SIZES_REPORTED) {
      expect(COLUMNS.map((column) => column.key)).toContain(`wait_mean_p${String(size)}_min`);
    }
  });

  it('1 行 1 実行で、先頭が列名の行になる', () => {
    const lines = toCsv(batch({ runs: 3 })).trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(COLUMNS.map((column) => column.key).join(','));
    expect(lines[1]?.split(',')).toHaveLength(COLUMNS.length);
  });

  it('同じシードなら、同じ CSV が出る', () => {
    expect(toCsv(batch())).toBe(toCsv(batch()));
  });

  it('シードが違えば、違う CSV が出る', () => {
    expect(toCsv(batch({ seed: 1 }))).not.toBe(toCsv(batch({ seed: 500 })));
  });

  it('自由席を省くと、その列は空欄になる', () => {
    const line = toCsv(batch({ baseline: false, runs: 1 })).split('\n')[1] ?? '';
    const index = COLUMNS.findIndex((column) => column.key === 'base_seated');
    expect(line.split(',')[index]).toBe('');
  });
});

describe('走らせた結果', () => {
  it('指定した回数ぶん、シードを 1 ずつ増やして走る', () => {
    const seen = batch({ runs: 3, seed: 10 });
    expect(seen.rows.map((row) => row.metrics.seed)).toEqual([10, 11, 12]);
  });

  /** **欠陥と覆い漏れが無いことが、数字を信じてよい条件である。** */
  it('実装の誤りも、席の区間の覆い漏れも出ない', () => {
    for (const name of SCENARIO_NAMES) {
      const seen = runBatch({ ...SMALL, scenario: name, runs: 1 });
      expect(seen.defects).toEqual([]);
      expect(seen.gaps).toEqual([]);
    }
  });
});

describe('画面に出す要約', () => {
  it('来た組・待ち時間・席・事故・自由席のすべてに触れている', () => {
    const text = summaryOf(batch());
    for (const heading of ['【来た組】', '【待ち時間】', '【席の使われ方】', '【事故と回復】', '【自由席との比較】']) {
      expect(text).toContain(heading);
    }
  });

  it('自由席を省くと、その節は出ない', () => {
    expect(summaryOf(batch({ baseline: false }))).not.toContain('【自由席との比較】');
  });

  /** **読み違えを招く数字には、必ず但し書きを添える。** */
  it('自由席の探索時間が「座れた組だけ」だと断っている', () => {
    expect(summaryOf(batch())).toContain('座れた組');
  });
});

describe('HTML レポート', () => {
  it('1 ファイルで完結し、外部のものを読まない', () => {
    const html = toHtml(batch());
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('<!doctype html>');
  });

  it('図が描かれている', () => {
    const html = toHtml(batch());
    // ヒストグラム 19 階級 × 2 系列 ＋ 人数別 6 × 2 系列。
    expect(html.match(/<rect/g)?.length).toBe(19 * 2 + PARTY_SIZES_REPORTED.length * 2);
  });

  /** 8.5 の限界。**絶対値を断定しない**ことを、読む人の目に入る場所に置く。 */
  it('数字の読み方（8.5 の限界）が書いてある', () => {
    const html = toHtml(batch());
    expect(html).toContain('絶対値を信じないこと');
    expect(html).toContain('現地観察');
    expect(html).toContain('OpenSeat に不利な側に倒してある');
  });
});
