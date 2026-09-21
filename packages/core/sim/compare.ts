/**
 * 方針の比較（全体プラン 8.2）。
 *
 * 7.16 の既定値は「もっともらしい初期値」であって結論ではない。**同じ人が同じ
 * 時刻に来る世界で設定だけを取り替え、何がどう動くかを数字で見る。**
 *
 * ## 対にして比べる
 *
 * どの設定でも同じシードを使うので、**同じ組が同じ時刻に、同じ人数で、同じ
 * 滞在時間だけ座る**（共通乱数。`rng.ts`）。だから 2 つの設定の差は、設定の差
 * だけになる。平均どうしを引くのではなく、**シードごとに引いてから平均する**
 * ので、揺らぎが打ち消し合って小さな差も見える。
 *
 * **差には標準誤差を添える。** 添えないと「0.3 組の差」が本物なのか揺らぎなのか
 * 分からず、既定値を変える根拠にならない。
 *
 * ## 何を最適化したかを、軸ごとに宣言する
 *
 * 待ち時間を縮めれば事故が増え、席を長く確保すれば回転が落ちる。**どれを取った
 * のかを言わずに「良くなった」と書かない**ため、軸の宣言に `optimises` を持たせ、
 * レポートはそれをそのまま見出しに使う。
 */

import type { Policy } from '../src/index.js';
import { DEFAULT_POLICY } from '../src/index.js';
import type { Metrics } from './metrics.js';
import { collect } from './metrics.js';
import { run } from './runner.js';
import type { Scenario } from './scenario.js';
import { withPolicy } from './scenario.js';

// ---- 比べる軸（8.2 の 7 項目） ----

/** 比べる 1 つの設定。**既定からの差分だけを書く。** */
export interface Variant {
  readonly label: string;
  readonly policy: Partial<Policy>;
}

/** 8.2 の 1 項目。 */
export interface Axis {
  readonly key: string;
  /** この軸で決めること。 */
  readonly question: string;
  /** **何を最適化して読むか。** レポートの見出しにそのまま使う。 */
  readonly optimises: string;
  /** 比べる設定。**先頭が現在の既定**で、差はここを基準に取る。 */
  readonly variants: readonly Variant[];
}

/**
 * 8.2 の 7 項目。**先頭の設定が 7.16 の現在の既定値**である。
 *
 * 値を足すときは、その軸で何を最適化するのかを `optimises` に書くこと。
 */
export const AXES: readonly Axis[] = [
  {
    key: 'allocation',
    question: '割当: 先着順をどこまで守るか（`fairness_override_min`）',
    optimises: '大人数の組の待ち時間と、先を越された回数',
    variants: [
      { label: '10 分（既定）', policy: {} },
      { label: '厳密 FIFO（0 分）', policy: { fairnessOverrideMin: 0 } },
      { label: '5 分', policy: { fairnessOverrideMin: 5 } },
      { label: '15 分', policy: { fairnessOverrideMin: 15 } },
      { label: '純 best fit（∞）', policy: { fairnessOverrideMin: Number.POSITIVE_INFINITY } },
    ],
  },
  {
    key: 'hold',
    question: 'ホールド: 呼び出してから何分待つか（`hold_min`、延長）',
    optimises: 'ノーショーで遊ばせた席時間と、間に合わなかった組の数',
    variants: [
      { label: '7 分・延長あり（既定）', policy: {} },
      { label: '5 分・延長あり', policy: { holdMin: 5 } },
      { label: '10 分・延長あり', policy: { holdMin: 10 } },
      { label: '7 分・延長なし', policy: { holdExtensionMin: 0, maxExtensions: 0 } },
    ],
  },
  {
    key: 'no_show',
    question: 'ノーショー: 来なかった人をどう扱うか（`no_show_policy`）',
    optimises: '席に着けた組の数と、利用者への厳しさ',
    variants: [
      { label: 'requeue_once（既定）', policy: {} },
      { label: 'cancel', policy: { noShowPolicy: 'cancel' } },
      { label: 'requeue_back', policy: { noShowPolicy: 'requeue_back' } },
    ],
  },
  {
    key: 'time_limit',
    question: '着席時間の上限: 促すか、取り上げるか（`time_limit_mode`）',
    optimises: '回転と、「案内された席が塞がっていた」事故率',
    variants: [
      { label: 'soft 60 分（既定）', policy: {} },
      { label: 'off', policy: { timeLimitMode: 'off' } },
      { label: 'soft 45 分', policy: { timeLimitMin: 45 } },
      { label: 'hard 60 分', policy: { timeLimitMode: 'hard' } },
    ],
  },
  {
    key: 'table_order',
    question: '席の処理順: 退席確認の新しさを見るか（`table_order`）',
    optimises: '「案内された席が塞がっていた」事故率',
    variants: [
      { label: '定員昇順 ＋ 退席確認の新しさ（既定）', policy: {} },
      { label: '定員昇順のみ', policy: { tableOrder: ['capacity_asc'] } },
    ],
  },
  {
    key: 'assign_needs_check',
    question: '確認要の席を、待ちの先頭に案内するか（`assign_needs_check`）',
    optimises: '席に着けた組の数と、確認要のまま塞がっていた時間',
    variants: [
      { label: '案内する（既定）', policy: {} },
      { label: '案内しない', policy: { assignNeedsCheck: false } },
    ],
  },
  {
    key: 'turnover',
    question: '片付けの猶予: 退席から次の案内まで何分空けるか（`turnover_min`）',
    optimises: '稼働率と待ち時間',
    variants: [
      { label: '0 分（既定）', policy: {} },
      { label: '1 分', policy: { turnoverMin: 1 } },
      { label: '2 分', policy: { turnoverMin: 2 } },
    ],
  },
];

// ---- 1 回ぶんの要約 ----

/**
 * 比較で見る数字。**軸をまたいで同じ並びにしてある**ので、表を並べて読める。
 *
 * ここに無いものは CSV（`pnpm sim --out`）で見る。比較の表に 93 列を並べても
 * 読めないので、結論に効くものだけを選んだ。
 */
export const DIGEST_FIELDS = [
  'seated',
  'balked',
  'leftWithoutSeat',
  'waitMeanMin',
  'waitP90Min',
  'toSeatP90Min',
  'toSeatMaxMin',
  'wait2MeanMin',
  'wait4MeanMin',
  'wait4P90Min',
  'occupiedShare',
  'fillShare',
  'heldShare',
  'noShowLostMin',
  'calls',
  'seatTaken',
  'seatTakenRate',
  'probedInUse',
  'noShows',
  'needsCheck',
  'needsCheckMin',
  'autoFreed',
  'overtakenMean',
  'overtakenMax',
  'etaMaeMin',
] as const;

export type DigestField = (typeof DIGEST_FIELDS)[number];

export type Digest = Readonly<Record<DigestField, number>>;

/**
 * 各項目に数を割り当てる。**総当たりの表なので、項目を足したらここも埋めなければ
 * 型が通らない。** 平均も差も標準誤差も、この 1 つの表を通って作られる。
 */
function digest(of: (field: DigestField) => number): Digest {
  return { ...flowOf(of), ...seatsOf(of), ...troubleOf(of) };
}

function flowOf(of: (field: DigestField) => number): Pick<Digest, FlowField> {
  return {
    seated: of('seated'),
    balked: of('balked'),
    leftWithoutSeat: of('leftWithoutSeat'),
    waitMeanMin: of('waitMeanMin'),
    waitP90Min: of('waitP90Min'),
    toSeatP90Min: of('toSeatP90Min'),
    toSeatMaxMin: of('toSeatMaxMin'),
    wait2MeanMin: of('wait2MeanMin'),
    wait4MeanMin: of('wait4MeanMin'),
    wait4P90Min: of('wait4P90Min'),
  };
}

type FlowField =
  | 'seated'
  | 'balked'
  | 'leftWithoutSeat'
  | 'waitMeanMin'
  | 'waitP90Min'
  | 'toSeatP90Min'
  | 'toSeatMaxMin'
  | 'wait2MeanMin'
  | 'wait4MeanMin'
  | 'wait4P90Min';

function seatsOf(of: (field: DigestField) => number): Pick<Digest, SeatField> {
  return {
    occupiedShare: of('occupiedShare'),
    fillShare: of('fillShare'),
    heldShare: of('heldShare'),
    noShowLostMin: of('noShowLostMin'),
  };
}

type SeatField = 'occupiedShare' | 'fillShare' | 'heldShare' | 'noShowLostMin';

function troubleOf(of: (field: DigestField) => number): Pick<Digest, TroubleField> {
  return {
    calls: of('calls'),
    seatTaken: of('seatTaken'),
    seatTakenRate: of('seatTakenRate'),
    probedInUse: of('probedInUse'),
    noShows: of('noShows'),
    needsCheck: of('needsCheck'),
    needsCheckMin: of('needsCheckMin'),
    autoFreed: of('autoFreed'),
    overtakenMean: of('overtakenMean'),
    overtakenMax: of('overtakenMax'),
    etaMaeMin: of('etaMaeMin'),
  };
}

type TroubleField =
  | 'calls'
  | 'seatTaken'
  | 'seatTakenRate'
  | 'probedInUse'
  | 'noShows'
  | 'needsCheck'
  | 'needsCheckMin'
  | 'autoFreed'
  | 'overtakenMean'
  | 'overtakenMax'
  | 'etaMaeMin';

/** 1 回の実行を、比較で見る数字にまとめる。 */
export function digestOf(metrics: Metrics): Digest {
  return { ...flowDigest(metrics), ...seatDigest(metrics), ...troubleDigest(metrics) };
}

/** その人数の組の待ち時間。1 組もいなければ 0。 */
function waitOf(metrics: Metrics, partySize: number): { readonly mean: number; readonly p90: number } {
  const slice = metrics.bySize.find((item) => item.partySize === partySize);
  return { mean: slice?.wait.meanMin ?? 0, p90: slice?.wait.p90Min ?? 0 };
}

function flowDigest(metrics: Metrics): Pick<Digest, FlowField> {
  return {
    seated: metrics.demand.seated,
    balked: metrics.demand.balked,
    leftWithoutSeat: metrics.demand.leftWithoutSeat,
    waitMeanMin: metrics.wait.meanMin,
    waitP90Min: metrics.wait.p90Min,
    toSeatP90Min: metrics.toSeat.p90Min,
    toSeatMaxMin: metrics.toSeat.maxMin,
    wait2MeanMin: waitOf(metrics, 2).mean,
    wait4MeanMin: waitOf(metrics, 4).mean,
    wait4P90Min: waitOf(metrics, 4).p90,
  };
}

function seatDigest(metrics: Metrics): Pick<Digest, SeatField> {
  return {
    occupiedShare: metrics.seatUse.occupiedShare,
    fillShare: metrics.seatUse.fillShare,
    heldShare: metrics.seatUse.heldShare,
    noShowLostMin: metrics.seatUse.noShowLostMin,
  };
}

function troubleDigest(metrics: Metrics): Pick<Digest, TroubleField> {
  return {
    calls: metrics.incidents.calls,
    seatTaken: metrics.incidents.seatTaken,
    seatTakenRate: metrics.incidents.seatTakenRate,
    probedInUse: metrics.incidents.probedInUse,
    noShows: metrics.incidents.noShows,
    needsCheck: metrics.recovery.needsCheck,
    needsCheckMin: metrics.recovery.needsCheckMin,
    autoFreed: metrics.recovery.clearedTo.FREE,
    overtakenMean: metrics.fairness.overtakenMean,
    overtakenMax: metrics.fairness.overtakenMax,
    etaMaeMin: metrics.eta.maeMin,
  };
}

// ---- 走らせて比べる ----

export interface CompareOptions {
  readonly scenario: Scenario;
  readonly runs: number;
  readonly seed: number;
  /** 比べる軸。既定は 8.2 の 7 項目すべて。 */
  readonly axes?: readonly Axis[];
}

/** 1 つの設定の結果。 */
export interface VariantResult {
  readonly axis: string;
  readonly label: string;
  /** この軸の基準（現在の既定値）か。 */
  readonly isBaseline: boolean;
  readonly mean: Digest;
  /** 基準との差。**シードごとに引いてから平均したもの。** 基準の行では 0。 */
  readonly delta: Digest;
  /** その差の標準誤差。**差がこれの 2 倍に届かないなら、揺らぎと区別できない。** */
  readonly stderr: Digest;
}

export interface CompareResult {
  readonly scenario: string;
  readonly runs: number;
  readonly seed: number;
  readonly axes: readonly Axis[];
  readonly results: readonly VariantResult[];
  /** 実装の誤りを示す拒否。**空でなければ失敗である。** */
  readonly defects: readonly string[];
}

/** 8.2 の比較を走らせる。 */
export function compare(options: CompareOptions): CompareResult {
  const axes: readonly Axis[] = options.axes ?? AXES;
  const defects: string[] = [];
  const results = axes.flatMap((axis) => resultsFor(axis, options, defects));
  return {
    scenario: options.scenario.name,
    runs: options.runs,
    seed: options.seed,
    axes,
    results,
    defects,
  };
}

function resultsFor(
  axis: Axis,
  options: CompareOptions,
  defects: string[],
): readonly VariantResult[] {
  const samples: readonly (readonly Digest[])[] = axis.variants.map((variant) =>
    sampleOf(variant, axis, options, defects),
  );
  const base: readonly Digest[] = samples[0] ?? [];
  return axis.variants.map((variant, index) =>
    summarise(axis, variant, index === 0, samples[index] ?? [], base),
  );
}

function summarise(
  axis: Axis,
  variant: Variant,
  isBaseline: boolean,
  mine: readonly Digest[],
  base: readonly Digest[],
): VariantResult {
  const paired: readonly Digest[] = pairwise(mine, base);
  return {
    axis: axis.key,
    label: variant.label,
    isBaseline,
    mean: digest((field) => round(average(mine.map((row) => row[field])))),
    delta: digest((field) => round(average(paired.map((row) => row[field])))),
    stderr: digest((field) => round(standardError(paired.map((row) => row[field])))),
  };
}

/** 1 つの設定を、指定された回数だけ走らせる。 */
function sampleOf(
  variant: Variant,
  axis: Axis,
  options: CompareOptions,
  defects: string[],
): readonly Digest[] {
  const scenario: Scenario = withPolicy(options.scenario, {
    ...DEFAULT_POLICY,
    ...options.scenario.policy,
    ...variant.policy,
  });
  return Array.from({ length: options.runs }, (_unused, index) => {
    const result = run({ scenario, seed: options.seed + index });
    for (const defect of result.defects) {
      defects.push(`${axis.key} / ${variant.label} / シード ${String(options.seed + index)}: ${defect.describe}`);
    }
    return digestOf(collect(result));
  });
}

/** シードごとの差。**平均どうしを引くより、揺らぎが打ち消し合う。** */
function pairwise(mine: readonly Digest[], base: readonly Digest[]): readonly Digest[] {
  return mine.map((row, index) => {
    const other: Digest | undefined = base[index];
    return digest((field) => row[field] - (other?.[field] ?? 0));
  });
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 差の標準誤差。**2 倍に届かない差は、揺らぎと区別できない。**
 *
 * 対にして取った差の散らばりを見ているので、設定と関係ない揺らぎ（その日の
 * 混み方）はすでに引き算で消えている。
 */
function standardError(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean: number = average(values);
  const variance: number =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---- 見せ方 ----

/** 画面に出す列。**軸によらず同じ並び**にしてあるので、表を並べて読める。 */
const TEXT_COLUMNS: readonly {
  readonly head: string;
  readonly field: DigestField;
  readonly width: number;
  readonly percent?: boolean;
}[] = [
  { head: '座れた', field: 'seated', width: 7 },
  { head: 'やめた', field: 'balked', width: 7 },
  { head: '座れず', field: 'leftWithoutSeat', width: 7 },
  { head: '待ち平均', field: 'waitMeanMin', width: 9 },
  { head: '待ちp90', field: 'waitP90Min', width: 8 },
  { head: '4名平均', field: 'wait4MeanMin', width: 8 },
  { head: '4名p90', field: 'wait4P90Min', width: 7 },
  { head: '越され', field: 'overtakenMean', width: 7 },
  { head: '事故率', field: 'seatTakenRate', width: 7, percent: true },
  { head: '空振り', field: 'probedInUse', width: 7 },
  { head: '稼働', field: 'occupiedShare', width: 6, percent: true },
  { head: '遊び分', field: 'noShowLostMin', width: 7 },
];

/** 画面に出す比較。軸ごとに 1 つの表。 */
export function compareText(result: CompareResult): string {
  const lines: string[] = [
    `方針の比較（全体プラン 8.2）  ${result.scenario}  ${String(result.runs)} 回  シード ${String(result.seed)}〜${String(result.seed + result.runs - 1)}`,
    '',
    '各行は 1 回あたりの平均。**± は既定との差の標準誤差で、差がその 2 倍に届かないなら揺らぎと区別できない。**',
  ];
  for (const axis of result.axes) lines.push('', ...axisLines(axis, result));
  return lines.join('\n');
}

function axisLines(axis: Axis, result: CompareResult): readonly string[] {
  const rows = result.results.filter((item) => item.axis === axis.key);
  const head: string = '  設定'.padEnd(34) + TEXT_COLUMNS.map((c) => c.head.padStart(c.width)).join('');
  return [
    `━━ ${axis.question}`,
    `   最適化して読むもの: ${axis.optimises}`,
    '',
    head,
    ...rows.flatMap((row) => variantLines(row)),
  ];
}

function variantLines(row: VariantResult): readonly string[] {
  const values: string = TEXT_COLUMNS.map((column) =>
    show(row.mean[column.field], column.percent ?? false).padStart(column.width),
  ).join('');
  if (row.isBaseline) return [`  ${row.label.padEnd(32)}${values}`];
  const deltas: string = TEXT_COLUMNS.map((column) =>
    delta(row.delta[column.field], row.stderr[column.field], column.percent ?? false).padStart(
      column.width,
    ),
  ).join('');
  return [`  ${row.label.padEnd(32)}${values}`, `  ${'└ 差'.padEnd(32)}${deltas}`];
}

function show(value: number, percent: boolean): string {
  return percent ? `${(value * 100).toFixed(1)}%` : value.toFixed(1);
}

/** 差。**標準誤差の 2 倍に届かないものは括弧に入れる**（揺らぎと区別できない）。 */
function delta(value: number, stderr: number, percent: boolean): string {
  const shown: string = percent
    ? `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}`
    : `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
  return Math.abs(value) >= stderr * 2 && stderr > 0 ? shown : `(${shown})`;
}

/** 1 行 1 設定の CSV。平均・差・差の標準誤差を、項目ごとに並べる。 */
export function compareCsv(result: CompareResult): string {
  const head: readonly string[] = [
    'scenario',
    'runs',
    'axis',
    'label',
    'is_baseline',
    ...DIGEST_FIELDS.flatMap((field) => [field, `d_${field}`, `se_${field}`]),
  ];
  const rows: readonly string[] = result.results.map((row) => csvRow(result, row));
  return `${[head.join(','), ...rows].join('\n')}\n`;
}

function csvRow(result: CompareResult, row: VariantResult): string {
  return [
    result.scenario,
    String(result.runs),
    row.axis,
    `"${row.label.replaceAll('"', '""')}"`,
    row.isBaseline ? '1' : '0',
    ...DIGEST_FIELDS.flatMap((field) => [
      String(row.mean[field]),
      String(row.delta[field]),
      String(row.stderr[field]),
    ]),
  ].join(',');
}
