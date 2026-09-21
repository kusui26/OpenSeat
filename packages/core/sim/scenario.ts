/**
 * シナリオ。全体プラン 8.1 の初期値を、そのまま読めるデータとして置く。
 *
 * **ここの数字は「もっともらしい初期値」であって結論ではない。** 8.1 が
 * 「現地観察で置き換える」と断っているとおり、Phase 0 の観察（17.4 の観察シート）
 * で差し替える。差し替えたときにどこを直せばよいかが一目で分かるように、
 * 出典の行と 1 対 1 になるよう並べてある。
 */

import type { DurationMs, Policy, Tag } from '../src/index.js';
import { DEFAULT_POLICY, minutes } from '../src/index.js';
import { arrivalWindow, type RateBucket, type Weighted } from './distributions.js';

/** 席 1 卓の仕様。 */
export interface TableSpec {
  readonly capacity: number;
  readonly count: number;
  readonly tags?: readonly Tag[];
}

/** 滞在時間のモデル（8.1）。 */
export interface StayModel {
  readonly medianMin: number;
  /** この人数以上は中央値を長くする。 */
  readonly largePartyFrom: number;
  readonly largePartyMedianMin: number;
  readonly sigma: number;
}

/** 呼び出しから着席までのモデル（8.1）。 */
export interface WalkModel {
  readonly medianMin: number;
  readonly p90Min: number;
}

/** ノーショーのモデル（8.1）。待ち時間が長いほど上がる。 */
export interface NoShowModel {
  readonly baseRate: number;
  readonly longWaitFromMin: number;
  readonly longWaitRate: number;
}

export interface Scenario {
  readonly name: string;
  readonly tables: readonly TableSpec[];
  readonly arrivals: readonly RateBucket[];
  readonly partySizes: readonly Weighted<number>[];
  readonly stay: StayModel;
  readonly walk: WalkModel;
  readonly noShow: NoShowModel;
  /**
   * 退席を申告する割合（8.1 は 60%）。
   *
   * **申告しなかった人の席は、整合性の回復（7.11）が拾う。** 8.1 が言う
   * 「p90 の問いかけ → 無応答 → 確認要」の経路をたどり、次の利用者かスタッフが
   * 確かめるか、`needs_check_auto_free_min` で自動的に空席へ戻る。この値を
   * 下げると、回復にかかる時間のぶんだけ回転が落ちる様子が出る。
   */
  readonly checkoutReportRate: number;
  /**
   * 登録せずに席へ向かう人（8.1「無断利用」）。1 卓 1 時間あたりの件数。
   *
   * 空席があるあいだに一定率で起きる。**このうち一部は座席 QR を読んで
   * 登録する**（7.12 の飛び込み着席）。読まない人は、システムから見えないまま
   * 席を使う「ゴースト」になる。
   */
  readonly unregisteredPerTableHour: number;
  /**
   * 登録せずに席へ向かった人のうち、座席 QR を読む割合（7.12）。
   *
   * **8.1 に数字が無い。** 7.12 は「登録しない理由を減らす」ことを狙いとして
   * いるが、どれだけ減るかは掲示と QR の置き方しだいで、現地観察と実証実験で
   * しか分からない。半々を初期値に置き、感度を見る。
   */
  readonly walkInShare: number;
  /**
   * 目安待ち時間が長いときに、登録をやめる割合（7.5 の 5）。
   *
   * **8.1 に数字が無い。** 7.5 は「40 分以上お待ちいただく見込みです。登録
   * しますか？」を出すとしているが、そこで何割が引き返すかは書かれていない。
   * 半々を初期値に置き、差し替えられるようにしてある（`walkInShare` と同じ扱い）。
   *
   * **この振る舞いが入るまで、過負荷のシナリオは現実より厳しく出ていた。**
   * 実際には目安を見た人が並ばないので、待ち行列は上限まで伸びきらない。
   */
  readonly balkShare: number;

  /** 受付を開けておく時間。ここを過ぎた到着は受け付けない。 */
  readonly joinOpenFor: DurationMs;
  /**
   * 運用が終わるまでの時間（全体プラン 7.14）。`null` なら終わらない。
   *
   * **既定は `null` にしてある。** 8.1 のシナリオは「ピークの 3 時間半」を
   * 切り出したもので、その先に閉店があるかどうかは 8.1 に書かれていない。
   * 運用終了を入れると、終了時刻に残っていた人が施設都合で取り消され、
   * 待ち時間や回転率の見え方が変わる。**測りたいものが変わってしまうので、
   * 運用時間を見たいときだけ `withClosing()` で足す。**
   */
  readonly closesAfter: DurationMs | null;
  readonly policy: Policy;
}

// ---- 席構成（8.1「席構成」の行） ----

/** 実証実験の候補区画。2 名席×4、4 名席×3、6 名席×1 で 26 席。 */
export const TABLES_26: readonly TableSpec[] = [
  { capacity: 2, count: 4 },
  { capacity: 4, count: 3 },
  { capacity: 6, count: 1 },
];

/** 比較用。同じ比率で 50 席。 */
export const TABLES_50: readonly TableSpec[] = [
  { capacity: 2, count: 7 },
  { capacity: 4, count: 6 },
  { capacity: 6, count: 2 },
];

/** 比較用。同じ比率で 100 席。 */
export const TABLES_100: readonly TableSpec[] = [
  { capacity: 2, count: 14 },
  { capacity: 4, count: 12 },
  { capacity: 6, count: 4 },
];

/** その席構成の総席数。 */
export function seatCount(tables: readonly TableSpec[]): number {
  return tables.reduce((sum, spec) => sum + spec.capacity * spec.count, 0);
}

// ---- 人数分布（8.1「人数分布」の行） ----

/**
 * 1 名 25%、2 名 40%、3 名 15%、4 名 15%、5 名以上 5%。
 *
 * **「5 名以上 5%」を 5 名 3%・6 名 2% に分けてある。** 6 名席を使う組が
 * 1 組も出ないと、大きい席を大人数のために残す規則（7.6）の効きを見られない。
 * 分け方そのものに根拠は無いので、現地観察で置き換えること。
 */
export const PARTY_SIZES: readonly Weighted<number>[] = [
  { value: 1, weight: 25 },
  { value: 2, weight: 40 },
  { value: 3, weight: 15 },
  { value: 4, weight: 15 },
  { value: 5, weight: 3 },
  { value: 6, weight: 2 },
];

// ---- 到着（8.1「到着」の行） ----

const QUARTER: DurationMs = minutes(15);

/** 15 分刻みの到着率を、先頭からの並びで書く。 */
function buckets(startMin: number, perHour: readonly number[]): readonly RateBucket[] {
  return perHour.map((rate, index) => ({
    from: minutes(startMin) + QUARTER * index,
    perHour: rate,
  }));
}

/**
 * 平日昼。8.1 は 20 組/時。
 *
 * 11:30 を 0 分として 2 時間ぶん。山を 12:15 に置き、平均が 20 組/時前後に
 * なるように前後を落としてある。
 */
export const WEEKDAY_ARRIVALS: readonly RateBucket[] = buckets(0, [12, 18, 24, 26, 24, 20, 14, 10]);

/**
 * 土日昼のピーク。8.1 は 11:30〜13:30 に 60〜90 組/時。
 *
 * 11:00 を 0 分として 3 時間半ぶん。11:30 から 13:30 が 60 を超える帯にあたる。
 *
 * **この率は施設全体のものである。** 8.1 の席構成と突き合わせると、
 * 100 席（`TABLES_100`）でちょうど釣り合う。26 席の実証区画に同じ率を
 * ぶつけると 4 倍の過負荷になるので、区画のシナリオでは席数の割合で
 * 減らす（`shareOfVenue`）。
 */
export const WEEKEND_ARRIVALS: readonly RateBucket[] = buckets(
  0,
  [30, 45, 60, 75, 90, 90, 85, 75, 70, 60, 45, 30, 20, 12],
);

/** 到着率を一定の割合で増減させる。 */
export function scaleArrivals(
  source: readonly RateBucket[],
  factor: number,
): readonly RateBucket[] {
  return source.map((bucket) => ({ from: bucket.from, perHour: bucket.perHour * factor }));
}

/**
 * 施設全体のうち、その席構成が占める割合。
 *
 * **対象席が施設の一部なら、登録するのもその割合の組だけ**という仮定を置く。
 * 区画が特別に混む／空くことは織り込んでいない。現地観察（Phase 0）で
 * 「対象区画に来た組数」を数えれば、この仮定を直接置き換えられる。
 */
export function shareOfVenue(tables: readonly TableSpec[]): number {
  return seatCount(tables) / seatCount(TABLES_100);
}

// ---- 振る舞いのモデル（8.1 の残りの行） ----

/** 滞在時間: 中央値 30 分、σ=0.4。4 名以上は中央値 40 分。 */
export const STAY: StayModel = {
  medianMin: 30,
  largePartyFrom: 4,
  largePartyMedianMin: 40,
  sigma: 0.4,
};

/** 呼び出し → 着席: 中央値 2 分、p90 6 分。 */
export const WALK: WalkModel = { medianMin: 2, p90Min: 6 };

/** ノーショー: 基礎 8%、待ち 20 分超で 15%。 */
export const NO_SHOW: NoShowModel = { baseRate: 0.08, longWaitFromMin: 20, longWaitRate: 0.15 };

/** 退席の申告率: 60%。 */
export const CHECKOUT_REPORT_RATE = 0.6;

/** 無断利用: ピーク時 1 卓あたり 0.2 件/時（8.1）。 */
export const UNREGISTERED_PER_TABLE_HOUR = 0.2;

/** そのうち座席 QR を読む割合。**8.1 に無い。現地観察で置き換える。** */
export const WALK_IN_SHARE = 0.5;

/** 目安が長いときに登録をやめる割合。**8.1 に無い。実証実験で置き換える。** */
export const BALK_SHARE = 0.5;

// ---- 既定のシナリオ ----

interface ScenarioParams {
  readonly name: string;
  readonly tables: readonly TableSpec[];
  readonly arrivals: readonly RateBucket[];
}

/**
 * 8.1 の既定値でシナリオを組み立てる。
 *
 * **受付時間は到着率の定義域から導く。** 別々に持つと、区間を足したときに
 * 受付時間を直し忘れ、最後の区間の率がそのまま延長されてしまう。
 */
function scenario(params: ScenarioParams): Scenario {
  return {
    name: params.name,
    tables: params.tables,
    arrivals: params.arrivals,
    partySizes: PARTY_SIZES,
    stay: STAY,
    walk: WALK,
    noShow: NO_SHOW,
    checkoutReportRate: CHECKOUT_REPORT_RATE,
    unregisteredPerTableHour: UNREGISTERED_PER_TABLE_HOUR,
    walkInShare: WALK_IN_SHARE,
    balkShare: BALK_SHARE,
    joinOpenFor: arrivalWindow(params.arrivals),
    closesAfter: null,
    policy: DEFAULT_POLICY,
  };
}

/** 平日昼。11:30 から 2 時間、26 席。8.1 の 20 組/時は 26 席とおおむね釣り合う。 */
export const WEEKDAY_LUNCH: Scenario = scenario({
  name: 'weekday-lunch',
  tables: TABLES_26,
  arrivals: WEEKDAY_ARRIVALS,
});

/**
 * 土日昼のピーク。3 時間半、26 席。**Phase 1 の完了条件が使うシナリオ。**
 *
 * 到着率は施設全体の率を席数の割合で減らしてある（`shareOfVenue`）。
 * 減らさないとどうなるかは `WEEKEND_OVERLOAD` で見られる。
 */
export const WEEKEND_PEAK: Scenario = scenario({
  name: 'weekend-peak',
  tables: TABLES_26,
  arrivals: scaleArrivals(WEEKEND_ARRIVALS, shareOfVenue(TABLES_26)),
});

/** 土日昼のピークを 50 席で。 */
export const WEEKEND_PEAK_50: Scenario = {
  ...WEEKEND_PEAK,
  name: 'weekend-peak-50',
  tables: TABLES_50,
  arrivals: scaleArrivals(WEEKEND_ARRIVALS, shareOfVenue(TABLES_50)),
};

/** 土日昼のピークを 100 席で。8.1 の到着率をそのまま使う。 */
export const WEEKEND_PEAK_100: Scenario = {
  ...WEEKEND_PEAK,
  name: 'weekend-peak-100',
  tables: TABLES_100,
  arrivals: WEEKEND_ARRIVALS,
};

/**
 * 26 席に施設全体の到着率をそのままぶつけたもの。**過負荷の挙動を見るため。**
 *
 * 受け入れられるのは 4 分の 1 ほどで、残りは待ち行列の上限（`max_queue_length`）
 * か受付からの絶対上限（`ticket_max_age_min`）で落ちる。**現実には、待ち時間の
 * 目安を見た人が登録をやめる**（7.5 の 5）。その振る舞いは待ち時間の推定
 * （PR 13）が要るので、この版ではモデル化していない。
 */
export const WEEKEND_OVERLOAD: Scenario = {
  ...WEEKEND_PEAK,
  name: 'weekend-overload',
  arrivals: WEEKEND_ARRIVALS,
};

/**
 * 選べるシナリオの名前。**型をここから導く。**
 *
 * 一覧が先にあると、`SCENARIOS` に載せ忘れた名前も、名前を付けずに足した
 * シナリオも型で落ちる。CLI の案内文と、シナリオを総なめするテストが、
 * この並びをそのまま使う。
 */
export const SCENARIO_NAMES = [
  'weekday-lunch',
  'weekend-peak',
  'weekend-peak-50',
  'weekend-peak-100',
  'weekend-overload',
] as const;

export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** 名前で引けるようにしたシナリオの一覧。CLI（PR 14）が使う。 */
export const SCENARIOS = {
  'weekday-lunch': WEEKDAY_LUNCH,
  'weekend-peak': WEEKEND_PEAK,
  'weekend-peak-50': WEEKEND_PEAK_50,
  'weekend-peak-100': WEEKEND_PEAK_100,
  'weekend-overload': WEEKEND_OVERLOAD,
} as const satisfies Readonly<Record<ScenarioName, Scenario>>;

/** 設定を差し替えたシナリオを作る。方針の比較（8.2）で使う。 */
export function withPolicy(base: Scenario, policy: Policy): Scenario {
  return { ...base, policy };
}

/**
 * 運用時間を持たせたシナリオを作る（全体プラン 7.14）。
 *
 * `after` は開始から運用終了までの時間。受付はその `join_cutoff_before_close_min`
 * 前に止まり、終了時刻に残っていた待ちは施設都合で取り消される。
 */
export function withClosing(base: Scenario, after: DurationMs): Scenario {
  return { ...base, closesAfter: after };
}

/** 退席の申告率を差し替えたシナリオを作る。 */
export function withCheckoutReportRate(base: Scenario, rate: number): Scenario {
  return { ...base, checkoutReportRate: rate };
}

/** 座席 QR を読む割合を差し替えたシナリオを作る（7.12 の効きを見る）。 */
export function withWalkInShare(base: Scenario, share: number): Scenario {
  return { ...base, walkInShare: share };
}

/** 無断利用の率を差し替えたシナリオを作る。 */
export function withUnregisteredRate(base: Scenario, perTableHour: number): Scenario {
  return { ...base, unregisteredPerTableHour: perTableHour };
}

/** 登録をやめる割合を差し替えたシナリオを作る（7.5 の 5 の効きを見る）。 */
export function withBalkShare(base: Scenario, share: number): Scenario {
  return { ...base, balkShare: share };
}
