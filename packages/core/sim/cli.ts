/**
 * CLI の中身（全体プラン 8.4）。
 *
 *     pnpm sim --scenario weekend-peak --runs 200 --seed 1 --out result.csv
 *
 * **ここには副作用が無い。** 引数を読み、走らせ、文字列を組み立てるところまでを
 * 純粋な関数にしてある。`process` と `node:fs` に触るのは `main.ts` だけで、
 * そのぶんここは丸ごとテストできる。
 *
 * ## `--policy` を付けていない
 *
 * 8.4 の例には `--policy default` があるが、今は `default` しか無く、置いても
 * 何もしない。**8.2 の 7 項目を振るのは PR 15 の仕事**で、そのための
 * `withPolicy()` はすでに `scenario.ts` にある。使われない旗を先に作らない。
 *
 * ## CSV の形
 *
 * **1 行 1 実行。** 列は `COLUMNS` に宣言してあり、**すべての列が 8.3 の項目
 * （`METRIC_TOPICS`）のどれかに属する**。属さない列は作れないし、項目に列が
 * 1 つも無ければテストが落ちる。指標を足したときに「8.3 のどれを測ったのか」を
 * 言えなくなるのを防ぐためである。
 */

import type { Result } from '../src/index.js';
import { err, ok } from '../src/index.js';
import type { BaselineMetrics, Distribution, Metrics, SizeSlice } from './metrics.js';
import { collect, collectBaseline, PARTY_SIZES_REPORTED, spanCoverage } from './metrics.js';
import { runBaseline } from './baseline.js';
import { run } from './runner.js';
import type { ScenarioName } from './scenario.js';
import { SCENARIO_NAMES, SCENARIOS } from './scenario.js';

// ---- 引数 ----

export interface CliOptions {
  readonly scenario: ScenarioName;
  readonly runs: number;
  /** 1 回目のシード。2 回目以降は 1 ずつ増える。 */
  readonly seed: number;
  /** CSV の書き出し先。`null` なら書かない。 */
  readonly out: string | null;
  /** HTML レポートの書き出し先。`null` なら書かない。 */
  readonly html: string | null;
  /** 自由席のベースラインも走らせるか。 */
  readonly baseline: boolean;
}

export const DEFAULT_OPTIONS: CliOptions = {
  scenario: 'weekend-peak',
  runs: 20,
  seed: 1,
  out: null,
  html: null,
  baseline: true,
};

/** 走らせられる回数の上限。打ち間違いで何時間も回さないための歯止め。 */
export const MAX_RUNS = 10_000;

export const USAGE = [
  'pnpm sim [オプション]',
  '',
  '  --scenario <名前>  走らせるシナリオ（既定 weekend-peak）',
  `  --runs <回数>      走らせる回数（既定 ${String(DEFAULT_OPTIONS.runs)}、上限 ${String(MAX_RUNS)}）`,
  `  --seed <整数>      1 回目のシード（既定 ${String(DEFAULT_OPTIONS.seed)}）`,
  '  --out <パス>       指標を CSV で書き出す（1 行 1 実行）',
  '  --html <パス>      分布のヒストグラムを HTML で書き出す',
  '  --no-baseline      自由席との比較を省く',
  '  --help             この案内を出す',
  '',
  `  シナリオ: ${SCENARIO_NAMES.join(', ')}`,
].join('\n');

/** 値を取る旗と、その受け取り先。 */
const VALUE_FLAGS = ['--scenario', '--runs', '--seed', '--out', '--html'] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];

function isValueFlag(value: string): value is ValueFlag {
  return VALUE_FLAGS.some((flag) => flag === value);
}

/**
 * 引数を読む。**知らない旗は黙って無視せず、失敗にする。**
 *
 * 打ち間違いを受け流すと、既定値で回った結果を「指定した設定の結果」だと
 * 思い込むことになる。
 */
export function parseArgs(argv: readonly string[]): Result<CliOptions, string> {
  let options: CliOptions = DEFAULT_OPTIONS;
  for (let index = 0; index < argv.length; index += 1) {
    const flag: string = argv[index] ?? '';
    if (flag === '--no-baseline') {
      options = { ...options, baseline: false };
      continue;
    }
    if (!isValueFlag(flag)) return err(`知らない指定です: ${flag}`);
    const value: string | undefined = argv[index + 1];
    if (value === undefined) return err(`${flag} に値がありません`);
    const applied = applyFlag(options, flag, value);
    if (!applied.ok) return applied;
    options = applied.value;
    index += 1;
  }
  return ok(options);
}

function applyFlag(options: CliOptions, flag: ValueFlag, value: string): Result<CliOptions, string> {
  switch (flag) {
    case '--scenario':
      return isScenarioName(value)
        ? ok({ ...options, scenario: value })
        : err(`知らないシナリオです: ${value}（${SCENARIO_NAMES.join(', ')}）`);
    case '--runs':
      return mapNumber(value, flag, 1, MAX_RUNS, (runs) => ({ ...options, runs }));
    case '--seed':
      return mapNumber(value, flag, 0, Number.MAX_SAFE_INTEGER, (seed) => ({ ...options, seed }));
    case '--out':
      return ok({ ...options, out: value });
    case '--html':
      return ok({ ...options, html: value });
  }
}

function isScenarioName(value: string): value is ScenarioName {
  return SCENARIO_NAMES.some((name) => name === value);
}

function mapNumber(
  value: string,
  flag: string,
  least: number,
  most: number,
  build: (parsed: number) => CliOptions,
): Result<CliOptions, string> {
  const parsed: number = Number(value);
  if (!Number.isInteger(parsed) || parsed < least || parsed > most) {
    return err(`${flag} は ${String(least)} 以上 ${String(most)} 以下の整数です: ${value}`);
  }
  return ok(build(parsed));
}

// ---- 走らせる ----

/** 1 回ぶんの結果。自由席を省いたときは `baseline` が `null`。 */
export interface Row {
  readonly metrics: Metrics;
  readonly baseline: BaselineMetrics | null;
}

export interface Batch {
  readonly options: CliOptions;
  readonly rows: readonly Row[];
  /**
   * 実装の誤りを示す拒否（`isDefect`）。**空でなければ失敗である。**
   */
  readonly defects: readonly string[];
  /**
   * 席の区間に覆い漏れがあった実行。**空でなければ失敗である。**
   *
   * 覆い漏れは稼働率を静かに小さくするだけで、例外を出さない。だから
   * 出力の手前で必ず確かめる。
   */
  readonly gaps: readonly string[];
}

/** 指定された回数だけ走らせ、指標を集める。 */
export function runBatch(options: CliOptions): Batch {
  const seeds: readonly number[] = Array.from(
    { length: options.runs },
    (_unused, index) => options.seed + index,
  );
  const outcomes: readonly Outcome[] = seeds.map((seed) => once(options, seed));
  return {
    options,
    rows: outcomes.map((outcome) => outcome.row),
    defects: outcomes.flatMap((outcome) => outcome.defects),
    gaps: outcomes.flatMap((outcome) => outcome.gaps),
  };
}

interface Outcome {
  readonly row: Row;
  readonly defects: readonly string[];
  readonly gaps: readonly string[];
}

/** 1 シードぶん走らせ、指標と「信じてよいか」を返す。 */
function once(options: CliOptions, seed: number): Outcome {
  const scenario = SCENARIOS[options.scenario];
  const result = run({ scenario, seed });
  return {
    row: {
      metrics: collect(result),
      baseline: options.baseline ? collectBaseline(runBaseline({ scenario, seed })) : null,
    },
    defects: result.defects.map((defect) => `シード ${String(seed)}: ${defect.describe}`),
    gaps: gapOf(seed, result),
  };
}

function gapOf(seed: number, result: Parameters<typeof spanCoverage>[0]): readonly string[] {
  const { expectedMin, observedMin } = spanCoverage(result);
  if (Math.abs(expectedMin - observedMin) < 0.2) return [];
  return [
    `シード ${String(seed)}: 席の区間が ${String(observedMin)} 分ぶんしかない（${String(expectedMin)} 分あるはず）`,
  ];
}

// ---- CSV ----

/**
 * 全体プラン 8.3 が求めている指標。**CSV の列は必ずどれかに属する。**
 *
 * `run` と `fairness` だけは 8.3 に無い。前者はどの実行かを示すためのもので、
 * 後者は 8.2 の 1 項目目（厳密 FIFO と本方式の比較）が要るものである。
 */
export const METRIC_TOPICS = {
  run: 'どの実行か',
  demand: '来た組がどうなったか',
  wait: '待ち時間の平均・p90・最大を人数別に',
  seat_use: '席の稼働率、ホールドで遊んだ時間、ノーショーで失われた席時間',
  incidents: '「案内された席が塞がっていた」事故の件数と率',
  endings: '放置・期限切れ・キャンセルの率',
  recovery: 'スタッフの介入回数（確認要の解消）',
  eta: 'ETA の予測誤差',
  fairness: '順番が守られたか（8.2 の 1 項目目に要る）',
  baseline: '自由席ベースラインとの比較（探索時間、着席までの時間）',
} as const;

export type MetricTopic = keyof typeof METRIC_TOPICS;

/** CSV の 1 列。 */
export interface Column {
  readonly key: string;
  readonly topic: MetricTopic;
  readonly of: (row: Row) => number | string;
}

function column(
  topic: MetricTopic,
  key: string,
  of: (row: Row) => number | string,
): Column {
  return { key, topic, of };
}

/** 人数別の 3 列を、1〜6 名ぶん並べる（8.3 の「人数別に」）。 */
function bySizeColumns(): readonly Column[] {
  return PARTY_SIZES_REPORTED.flatMap((size, index): readonly Column[] => {
    const slice = (row: Row): SizeSlice | undefined => row.metrics.bySize[index];
    return [
      column('wait', `wait_n_p${String(size)}`, (row) => slice(row)?.parties ?? 0),
      column('wait', `wait_mean_p${String(size)}_min`, (row) => slice(row)?.wait.meanMin ?? 0),
      column('wait', `wait_p90_p${String(size)}_min`, (row) => slice(row)?.wait.p90Min ?? 0),
    ];
  });
}

/** 自由席の列。走らせていなければ空欄にする。 */
function baseColumn(key: string, of: (base: BaselineMetrics) => number): Column {
  return column('baseline', key, (row) => (row.baseline === null ? '' : of(row.baseline)));
}

/** CSV の列。**この並びがそのまま出力の並びになる。** */
export const COLUMNS: readonly Column[] = [
  column('run', 'scenario', (row) => row.metrics.scenario),
  column('run', 'seed', (row) => row.metrics.seed),
  column('run', 'tables', (row) => row.metrics.tables),
  column('run', 'seats', (row) => row.metrics.seats),

  column('demand', 'arrived', (row) => row.metrics.demand.arrived),
  column('demand', 'balked', (row) => row.metrics.demand.balked),
  column('demand', 'refused', (row) => row.metrics.demand.refused),
  column('demand', 'joined', (row) => row.metrics.demand.joined),
  column('demand', 'walk_ins', (row) => row.metrics.demand.walkIns),
  column('demand', 'seated', (row) => row.metrics.demand.seated),
  column('demand', 'left_without_seat', (row) => row.metrics.demand.leftWithoutSeat),

  column('wait', 'wait_n', (row) => row.metrics.wait.count),
  column('wait', 'wait_mean_min', (row) => row.metrics.wait.meanMin),
  column('wait', 'wait_p50_min', (row) => row.metrics.wait.p50Min),
  column('wait', 'wait_p90_min', (row) => row.metrics.wait.p90Min),
  column('wait', 'wait_max_min', (row) => row.metrics.wait.maxMin),
  column('wait', 'to_seat_mean_min', (row) => row.metrics.toSeat.meanMin),
  column('wait', 'to_seat_p90_min', (row) => row.metrics.toSeat.p90Min),
  column('wait', 'to_seat_max_min', (row) => row.metrics.toSeat.maxMin),
  ...bySizeColumns(),

  column('seat_use', 'managed_table_min', (row) => row.metrics.seatUse.managedTableMin),
  column('seat_use', 'occupied_share', (row) => row.metrics.seatUse.occupiedShare),
  column('seat_use', 'held_share', (row) => row.metrics.seatUse.heldShare),
  column('seat_use', 'turnover_share', (row) => row.metrics.seatUse.turnoverShare),
  column('seat_use', 'needs_check_share', (row) => row.metrics.seatUse.needsCheckShare),
  column('seat_use', 'unknown_share', (row) => row.metrics.seatUse.unknownShare),
  column('seat_use', 'free_share', (row) => row.metrics.seatUse.freeShare),
  column('seat_use', 'fill_share', (row) => row.metrics.seatUse.fillShare),
  column('seat_use', 'no_show_lost_min', (row) => row.metrics.seatUse.noShowLostMin),

  column('incidents', 'calls', (row) => row.metrics.incidents.calls),
  column('incidents', 'seat_taken', (row) => row.metrics.incidents.seatTaken),
  column('incidents', 'seat_taken_rate', (row) => row.metrics.incidents.seatTakenRate),
  column('incidents', 'no_shows', (row) => row.metrics.incidents.noShows),
  column('incidents', 'no_show_rate', (row) => row.metrics.incidents.noShowRate),

  column('recovery', 'needs_check', (row) => row.metrics.recovery.needsCheck),
  column('recovery', 'needs_check_overstay', (row) => row.metrics.recovery.byOverstay),
  column('recovery', 'needs_check_no_answer', (row) => row.metrics.recovery.byNoAnswer),
  column('recovery', 'needs_check_unknown_aged', (row) => row.metrics.recovery.byUnknownAged),
  column('recovery', 'needs_check_min', (row) => row.metrics.recovery.needsCheckMin),
  column('recovery', 'cleared_to_free', (row) => row.metrics.recovery.clearedTo.FREE),
  column('recovery', 'cleared_to_occupied', (row) => row.metrics.recovery.clearedTo.OCCUPIED),
  column('recovery', 'cleared_to_unknown', (row) => row.metrics.recovery.clearedTo.OCCUPIED_UNKNOWN),
  column('recovery', 'cleared_to_turnover', (row) => row.metrics.recovery.clearedTo.TURNOVER),
  column('recovery', 'cleared_to_disabled', (row) => row.metrics.recovery.clearedTo.DISABLED),

  column('endings', 'end_checked_out', (row) => row.metrics.endings.checked_out),
  column('endings', 'end_staff_checkout', (row) => row.metrics.endings.staff_checkout),
  column('endings', 'end_auto_release', (row) => row.metrics.endings.auto_release),
  column('endings', 'end_user_cancel', (row) => row.metrics.endings.user_cancel),
  column('endings', 'end_staff_cancel', (row) => row.metrics.endings.staff_cancel),
  column('endings', 'end_venue_closed', (row) => row.metrics.endings.venue_closed),
  column('endings', 'end_no_show', (row) => row.metrics.endings.no_show),
  column('endings', 'end_abandoned', (row) => row.metrics.endings.abandoned),
  column('endings', 'end_pause_expired', (row) => row.metrics.endings.pause_expired),
  column('endings', 'end_max_age', (row) => row.metrics.endings.max_age),

  column('fairness', 'overtaken_mean', (row) => row.metrics.fairness.overtakenMean),
  column('fairness', 'overtaken_max', (row) => row.metrics.fairness.overtakenMax),
  column('fairness', 'overtaken_share', (row) => row.metrics.fairness.overtakenShare),

  column('eta', 'eta_n', (row) => row.metrics.eta.samples),
  column('eta', 'eta_unmatched', (row) => row.metrics.eta.unmatched),
  column('eta', 'eta_mae_min', (row) => row.metrics.eta.maeMin),
  column('eta', 'eta_bias_min', (row) => row.metrics.eta.biasMin),
  column('eta', 'eta_in_bucket_share', (row) => row.metrics.eta.inBucketShare),

  baseColumn('base_arrived', (base) => base.arrived),
  baseColumn('base_seated', (base) => base.seated),
  baseColumn('base_gave_up', (base) => base.gaveUp),
  baseColumn('base_still_searching', (base) => base.stillSearching),
  baseColumn('base_search_mean_min', (base) => base.search.meanMin),
  baseColumn('base_search_p50_min', (base) => base.search.p50Min),
  baseColumn('base_search_p90_min', (base) => base.search.p90Min),
  baseColumn('base_search_max_min', (base) => base.search.maxMin),
  baseColumn('base_search_mean_p2_min', (base) => base.bySize[1]?.wait.meanMin ?? 0),
  baseColumn('base_search_mean_p4_min', (base) => base.bySize[3]?.wait.meanMin ?? 0),
  baseColumn('base_occupied_share', (base) => base.occupiedShare),
  baseColumn('base_fill_share', (base) => base.fillShare),
  baseColumn('base_overtaken_mean', (base) => base.fairness.overtakenMean),
  baseColumn('base_overtaken_max', (base) => base.fairness.overtakenMax),
];

/** 1 行 1 実行の CSV。先頭は列名の行。 */
export function toCsv(batch: Batch): string {
  const lines: readonly string[] = [
    COLUMNS.map((item) => item.key).join(','),
    ...batch.rows.map((row) => COLUMNS.map((item) => cell(item.of(row))).join(',')),
  ];
  return `${lines.join('\n')}\n`;
}

/** 区切りや引用符を含む値だけを囲む。 */
function cell(value: number | string): string {
  const text: string = typeof value === 'number' ? String(value) : value;
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// ---- 画面に出す要約 ----

/** 実行をまたいだ平均。 */
function meanOf(rows: readonly Row[], pick: (row: Row) => number): number {
  if (rows.length === 0) return 0;
  return Math.round((rows.reduce((sum, row) => sum + pick(row), 0) / rows.length) * 10) / 10;
}

function pad(value: number | string, width: number): string {
  return String(value).padStart(width);
}

/**
 * 画面に出す要約。**実行をまたいだ平均**を並べる。
 *
 * p90 の平均は「各回の p90 の平均」であって、全部をまとめた p90 ではない。
 * まとめた p90 は混んだ回に引きずられるので、回ごとの代表値を平均している。
 */
export function summaryOf(batch: Batch): string {
  const { rows } = batch;
  const lines: string[] = [
    `${batch.options.scenario}  ${String(rows.length)} 回  シード ${String(batch.options.seed)}〜${String(batch.options.seed + rows.length - 1)}`,
    '',
    ...demandLines(rows),
    '',
    ...waitLines(rows),
    '',
    ...seatLines(rows),
    '',
    ...recoveryLines(rows),
  ];
  if (rows.some((row) => row.baseline !== null)) lines.push('', ...baselineLines(rows));
  return lines.join('\n');
}

function demandLines(rows: readonly Row[]): readonly string[] {
  const of = (pick: (row: Row) => number): string => pad(meanOf(rows, pick), 7);
  return [
    '【来た組】（1 回あたりの平均）',
    `  到着 ${of((row) => row.metrics.demand.arrived)}   受付 ${of((row) => row.metrics.demand.joined)}   着席 ${of((row) => row.metrics.demand.seated)}   飛び込み ${of((row) => row.metrics.demand.walkIns)}`,
    `  目安を見てやめた ${of((row) => row.metrics.demand.balked)}   受付を断られた ${of((row) => row.metrics.demand.refused)}   座れず終わった ${of((row) => row.metrics.demand.leftWithoutSeat)}`,
  ];
}

function waitLines(rows: readonly Row[]): readonly string[] {
  const dist = (pick: (row: Row) => Distribution): string =>
    `平均 ${pad(meanOf(rows, (row) => pick(row).meanMin), 6)}   p90 ${pad(meanOf(rows, (row) => pick(row).p90Min), 6)}   最大 ${pad(meanOf(rows, (row) => pick(row).maxMin), 6)}`;
  return [
    '【待ち時間】（分）',
    `  受付 → 呼び出し   ${dist((row) => row.metrics.wait)}`,
    `  受付 → 着席       ${dist((row) => row.metrics.toSeat)}`,
    ...PARTY_SIZES_REPORTED.map(
      (size, index) =>
        `  ${String(size)} 名組 (n=${pad(meanOf(rows, (row) => row.metrics.bySize[index]?.parties ?? 0), 5)})  ${dist((row) => row.metrics.bySize[index]?.wait ?? EMPTY)}`,
    ),
  ];
}

const EMPTY: Distribution = {
  count: 0,
  meanMin: 0,
  p50Min: 0,
  p90Min: 0,
  maxMin: 0,
  histogram: [],
};

function seatLines(rows: readonly Row[]): readonly string[] {
  const percent = (pick: (row: Row) => number): string =>
    `${pad(meanOf(rows, (row) => pick(row) * 100), 5)}%`;
  return [
    '【席の使われ方】',
    `  稼働 ${percent((row) => row.metrics.seatUse.occupiedShare)}   空席 ${percent((row) => row.metrics.seatUse.freeShare)}   確保して待たせた ${percent((row) => row.metrics.seatUse.heldShare)}`,
    `  確認要 ${percent((row) => row.metrics.seatUse.needsCheckShare)}   無断利用 ${percent((row) => row.metrics.seatUse.unknownShare)}   定員の埋まり ${percent((row) => row.metrics.seatUse.fillShare)}`,
    `  ノーショーで遊ばせた席時間 ${pad(meanOf(rows, (row) => row.metrics.seatUse.noShowLostMin), 6)} 分`,
  ];
}

function recoveryLines(rows: readonly Row[]): readonly string[] {
  const of = (pick: (row: Row) => number): string => pad(meanOf(rows, pick), 6);
  return [
    '【事故と回復】（1 回あたりの平均）',
    `  呼び出し ${of((row) => row.metrics.incidents.calls)}   席が塞がっていた ${of((row) => row.metrics.incidents.seatTaken)}   来なかった ${of((row) => row.metrics.incidents.noShows)}`,
    `  確認要 ${of((row) => row.metrics.recovery.needsCheck)}   うち利用者が解消 ${of((row) => row.metrics.recovery.clearedTo.OCCUPIED)}   自動解放など ${of((row) => row.metrics.recovery.clearedTo.FREE)}`,
    `  先を越された回数  平均 ${of((row) => row.metrics.fairness.overtakenMean)}   最大 ${of((row) => row.metrics.fairness.overtakenMax)}`,
    `  目安の誤差  MAE ${of((row) => row.metrics.eta.maeMin)} 分   偏り ${of((row) => row.metrics.eta.biasMin)} 分   突き合わせ ${of((row) => row.metrics.eta.samples)} 件（測れず ${of((row) => row.metrics.eta.unmatched)} 件）`,
  ];
}

function baselineLines(rows: readonly Row[]): readonly string[] {
  const of = (pick: (base: BaselineMetrics) => number): string =>
    pad(meanOf(rows, (row) => (row.baseline === null ? 0 : pick(row.baseline))), 6);
  return [
    '【自由席との比較】（1 回あたりの平均。同じ組が同じ時刻に来た場合）',
    `  座れた ${of((base) => base.seated)}   諦めた ${of((base) => base.gaveUp)}   最後まで探していた ${of((base) => base.stillSearching)}`,
    `  探索時間  平均 ${of((base) => base.search.meanMin)} 分   p90 ${of((base) => base.search.p90Min)} 分   最大 ${of((base) => base.search.maxMin)} 分`,
    `  2 名組 ${of((base) => base.bySize[1]?.wait.meanMin ?? 0)} 分   4 名組 ${of((base) => base.bySize[3]?.wait.meanMin ?? 0)} 分`,
    `  稼働 ${of((base) => base.occupiedShare * 100)}%   定員の埋まり ${of((base) => base.fillShare * 100)}%   先を越された 平均 ${of((base) => base.fairness.overtakenMean)}`,
    '',
    '  ※ 自由席の探索時間は「座れた組」だけの平均である。諦めた組を含めていない。',
    '  ※ 自由席の側には無断利用も片付けの猶予も無い。比較は OpenSeat に不利な側に倒してある。',
  ];
}
