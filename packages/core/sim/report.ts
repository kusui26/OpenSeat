/**
 * 簡易 HTML レポート（全体プラン 8.4）。
 *
 * **平均と p90 だけでは、施設に見せる話にならない。** 「ほとんどが 10 分、一部が
 * 90 分」と「全員が 30 分前後」は同じ平均になりうるが、現場で起きることは
 * まったく違う。分布の形を 1 枚で見せるためのものである。
 *
 * ## 作り方の決まり
 *
 * - **1 ファイルで完結する。** 外部のスクリプトも CSS も画像も読まない。
 *   施設に渡す・Issue に貼る・オフラインで開く、のどれもができる
 * - 図は素の SVG。描画ライブラリを入れない（`packages/core` は依存ゼロで、
 *   シミュレータもそれに倣う）
 * - **絶対値を断定しない。** 8.5 の限界を本文に必ず刷り込む
 */

import type { Batch, Row } from './cli.js';
import type { BaselineMetrics, Distribution } from './metrics.js';
import { HISTOGRAM_BUCKETS, HISTOGRAM_STEP_MIN, PARTY_SIZES_REPORTED } from './metrics.js';

/** 図の大きさ（利用者の画面ではなく、印刷してちょうどよい幅）。 */
const CHART = { width: 720, height: 220, padding: 32 } as const;

/** HTML レポートを組み立てる。 */
export function toHtml(batch: Batch): string {
  const title = `OpenSeat シミュレーション — ${batch.options.scenario}`;
  return [
    head(title),
    '<body>',
    `<h1>${escape(title)}</h1>`,
    `<p class="lead">${escape(subtitle(batch))}</p>`,
    summaryTable(batch),
    seatToSeatChart(batch),
    bySizeChart(batch),
    CAVEATS,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function head(title: string): string {
  return [
    '<!doctype html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escape(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
  ].join('\n');
}

function subtitle(batch: Batch): string {
  const { options, rows } = batch;
  const seeds = `シード ${String(options.seed)}〜${String(options.seed + rows.length - 1)}`;
  const tables: string = rows[0] === undefined ? '' : `｜${String(rows[0].metrics.tables)} 卓 ${String(rows[0].metrics.seats)} 席`;
  return `${String(rows.length)} 回の平均｜${seeds}${tables}`;
}

// ---- 要約の表 ----

interface Line {
  readonly label: string;
  readonly openSeat: string;
  readonly baseline: string;
}

function summaryTable(batch: Batch): string {
  const lines: readonly Line[] = summaryLines(batch);
  const body: readonly string[] = lines.map(
    (line) =>
      `<tr><th>${escape(line.label)}</th><td>${escape(line.openSeat)}</td><td>${escape(line.baseline)}</td></tr>`,
  );
  return [
    '<h2>要約</h2>',
    '<table>',
    '<thead><tr><th></th><th>OpenSeat</th><th>自由席</th></tr></thead>',
    `<tbody>${body.join('')}</tbody>`,
    '</table>',
  ].join('\n');
}

/**
 * 要約に並べる行。**OpenSeat 側と自由席側で、同じ意味の数字を組にしてある。**
 *
 * 表として宣言しておくと、片方だけ足して並びがずれることが起きない。
 */
const SUMMARY_ROWS: readonly {
  readonly label: string;
  readonly own: (row: Row) => number;
  readonly base: (metrics: BaselineMetrics) => number;
}[] = [
  { label: '来た組', own: (row) => row.metrics.demand.arrived, base: (m) => m.arrived },
  { label: '席に着けた組', own: (row) => row.metrics.demand.seated, base: (m) => m.seated },
  { label: '自分からやめた組', own: (row) => row.metrics.demand.balked, base: (m) => m.gaveUp },
  {
    label: '席に着けなかった組',
    own: (row) => row.metrics.demand.leftWithoutSeat,
    base: (m) => m.stillSearching,
  },
  {
    label: '席に着くまで 平均（分）',
    own: (row) => row.metrics.toSeat.meanMin,
    base: (m) => m.search.meanMin,
  },
  {
    label: '席に着くまで p90（分）',
    own: (row) => row.metrics.toSeat.p90Min,
    base: (m) => m.search.p90Min,
  },
  {
    label: '席に着くまで 最大（分）',
    own: (row) => row.metrics.toSeat.maxMin,
    base: (m) => m.search.maxMin,
  },
  {
    label: '2 名組 席に着くまで（分）',
    own: (row) => row.metrics.bySize[1]?.wait.meanMin ?? 0,
    base: (m) => m.bySize[1]?.wait.meanMin ?? 0,
  },
  {
    label: '4 名組 席に着くまで（分）',
    own: (row) => row.metrics.bySize[3]?.wait.meanMin ?? 0,
    base: (m) => m.bySize[3]?.wait.meanMin ?? 0,
  },
  {
    label: '稼働率（%）',
    own: (row) => row.metrics.seatUse.occupiedShare * 100,
    base: (m) => m.occupiedShare * 100,
  },
  {
    label: '定員の埋まり（%）',
    own: (row) => row.metrics.seatUse.fillShare * 100,
    base: (m) => m.fillShare * 100,
  },
  {
    label: '先を越された回数 平均',
    own: (row) => row.metrics.fairness.overtakenMean,
    base: (m) => m.fairness.overtakenMean,
  },
  {
    label: '先を越された回数 最大',
    own: (row) => row.metrics.fairness.overtakenMax,
    base: (m) => m.fairness.overtakenMax,
  },
];

function summaryLines(batch: Batch): readonly Line[] {
  const known: boolean = batch.rows.some((row) => row.baseline !== null);
  return SUMMARY_ROWS.map((item) => ({
    label: item.label,
    openSeat: fixed(mean(batch.rows, item.own)),
    baseline: known
      ? fixed(mean(batch.rows, (row) => (row.baseline === null ? 0 : item.base(row.baseline))))
      : '—',
  }));
}

// ---- 図 ----

/** 席に着くまでの時間の分布。OpenSeat と自由席を並べる。 */
function seatToSeatChart(batch: Batch): string {
  const own: readonly number[] = totalHistogram(batch.rows, (row) => row.metrics.toSeat);
  const base: readonly number[] = totalHistogram(batch.rows, (row) => row.baseline?.search ?? null);
  return [
    '<h2>席に着くまでの時間</h2>',
    '<p class="note">横軸は 5 分刻み。いちばん右は 90 分以上。</p>',
    `<p class="legend"><span class="key own"></span>OpenSeat<span class="key base"></span>自由席</p>`,
    histogramSvg([
      { values: own, className: 'own' },
      { values: base, className: 'base' },
    ]),
  ].join('\n');
}

/** 人数別の待ち時間（平均）。2 名組と 4 名組の差を見るためのもの（8.3）。 */
function bySizeChart(batch: Batch): string {
  const own: readonly number[] = PARTY_SIZES_REPORTED.map((_size, index) =>
    mean(batch.rows, (row) => row.metrics.bySize[index]?.wait.meanMin ?? 0),
  );
  const base: readonly number[] = PARTY_SIZES_REPORTED.map((_size, index) =>
    mean(batch.rows, (row) => row.baseline?.bySize[index]?.wait.meanMin ?? 0),
  );
  return [
    '<h2>人数別の 席に着くまでの時間（平均、分）</h2>',
    `<p class="legend"><span class="key own"></span>OpenSeat<span class="key base"></span>自由席</p>`,
    barsSvg(
      PARTY_SIZES_REPORTED.map((size) => `${String(size)} 名`),
      [
        { values: own, className: 'own' },
        { values: base, className: 'base' },
      ],
    ),
  ].join('\n');
}

/** 1 本の系列。 */
interface Series {
  readonly values: readonly number[];
  readonly className: string;
}

/** 5 分刻みのヒストグラム。系列を横に並べて描く。 */
function histogramSvg(series: readonly Series[]): string {
  const labels: readonly string[] = Array.from({ length: HISTOGRAM_BUCKETS }, (_unused, index) =>
    index === HISTOGRAM_BUCKETS - 1
      ? `${String(index * HISTOGRAM_STEP_MIN)}+`
      : String(index * HISTOGRAM_STEP_MIN),
  );
  return barsSvg(labels, series);
}

/**
 * 棒グラフ。**目盛りの最大は系列全体の最大**なので、2 つの系列を見比べられる。
 */
function barsSvg(labels: readonly string[], series: readonly Series[]): string {
  const top: number = Math.max(...series.flatMap((item) => [...item.values]), 1);
  const { width, height, padding } = CHART;
  const slot: number = (width - padding * 2) / labels.length;
  const barWidth: number = Math.max(slot / (series.length + 0.5), 1);

  return [
    `<svg viewBox="0 0 ${String(width)} ${String(height)}" role="img">`,
    `<line class="axis" x1="${String(padding)}" y1="${String(height - padding)}" x2="${String(width - padding)}" y2="${String(height - padding)}" />`,
    `<text class="tick" x="${String(padding)}" y="${String(padding - 8)}">最大 ${fixed(top)}</text>`,
    ...series.flatMap((item, order) => bars(item, { top, slot, barWidth, order })),
    ...labels.map(
      (label, index) =>
        `<text class="tick" x="${round(padding + slot * index + slot / 2)}" y="${String(height - padding + 14)}">${escape(label)}</text>`,
    ),
    '</svg>',
  ].join('');
}

/** 1 系列ぶんの棒。`order` が系列の並び順で、そのぶん横にずらす。 */
function bars(
  series: Series,
  layout: { readonly top: number; readonly slot: number; readonly barWidth: number; readonly order: number },
): readonly string[] {
  const { height, padding } = CHART;
  return series.values.map((value, index) => {
    const tall: number = Math.max(((height - padding * 2) * value) / layout.top, 0);
    const x: number = padding + layout.slot * index + layout.barWidth * layout.order;
    return rect(x, height - padding - tall, layout.barWidth, tall, series.className);
  });
}

function rect(x: number, y: number, width: number, height: number, className: string): string {
  return `<rect class="${className}" x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" />`;
}

// ---- まとめかた ----

function mean(rows: readonly Row[], pick: (row: Row) => number): number {
  if (rows.length === 0) return 0;
  return rows.reduce((sum, row) => sum + pick(row), 0) / rows.length;
}

/** 実行をまたいで度数を足す。系列が無ければ 0 の並びを返す。 */
function totalHistogram(
  rows: readonly Row[],
  pick: (row: Row) => Distribution | null,
): readonly number[] {
  const empty: readonly number[] = Array.from({ length: HISTOGRAM_BUCKETS }, () => 0);
  return rows.reduce<readonly number[]>((totals, row) => {
    const found: Distribution | null = pick(row);
    if (found === null) return totals;
    return totals.map((value, index) => value + (found.histogram[index] ?? 0));
  }, empty);
}

function fixed(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** HTML に埋め込む前に、記号を逃がす。 */
function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ---- 決め打ちの部分 ----

const CAVEATS = [
  '<h2>この数字の読み方</h2>',
  '<ul class="caveats">',
  '<li><strong>絶対値を信じないこと。</strong> 到着率・滞在時間・無断利用率は全体プラン 8.1 の初期値で、',
  '現地観察（Phase 0）で置き換える前のものである。この図が示せるのは<strong>ルールの相対比較</strong>までで、',
  '実際の待ち時間は実証実験で確かめる（8.5）。</li>',
  '<li><strong>自由席の側は有利に見積もってある。</strong> 無断利用も片付けの猶予も無く、',
  '席を探す速さ（1 分に 2 卓）は観察で校正していない。<strong>比較は OpenSeat に不利な側に倒してある。</strong></li>',
  '<li><strong>「自分からやめた組」の意味が両者で違う。</strong> OpenSeat では待ち時間の目安を見て登録をやめた組で、',
  '自由席では探しているうちに諦めた組である。<strong>前者は情報を得たうえでの判断であり、後者はそうではない。</strong></li>',
  '<li>人の行動（掲示に従う率、無断利用率）は観察でしか分からない（8.5）。</li>',
  '</ul>',
].join('\n');

const STYLE = `
:root { color-scheme: light dark; --ink: #1a1a1a; --paper: #fff; --line: #d5d5d5; --own: #2f6f4f; --base: #9a7b3f; --muted: #666; }
@media (prefers-color-scheme: dark) {
  :root { --ink: #eaeaea; --paper: #16181a; --line: #3a3d40; --own: #6fc79a; --base: #d6b26a; --muted: #a3a3a3; }
}
body { margin: 0 auto; padding: 24px 16px 64px; max-width: 800px; background: var(--paper); color: var(--ink);
  font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; line-height: 1.7; }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
h2 { font-size: 1.1rem; margin: 40px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
.lead, .note { color: var(--muted); margin: 0 0 8px; font-size: .9rem; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: right; }
thead th, tbody th { text-align: left; font-weight: 600; }
svg { width: 100%; height: auto; }
.own { fill: var(--own); }
.base { fill: var(--base); }
.axis { stroke: var(--line); }
.tick { fill: var(--muted); font-size: 10px; text-anchor: middle; }
.legend { font-size: .85rem; color: var(--muted); margin: 0 0 4px; }
.legend .key { display: inline-block; width: 10px; height: 10px; margin: 0 4px 0 12px; }
.legend .key.own { background: var(--own); }
.legend .key.base { background: var(--base); }
.legend .key:first-child { margin-left: 0; }
.caveats { font-size: .9rem; }
.caveats li { margin-bottom: 8px; }
`;
