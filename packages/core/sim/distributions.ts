/**
 * 分布。全体プラン 8.1 のモデルをそのまま関数にする。
 *
 * | 要素 | 分布 | ここでの関数 |
 * |---|---|---|
 * | 到着 | 15 分刻みの到着率を持つ非定常ポアソン過程 | `arrivalTimes` |
 * | 人数 | 離散分布 | `discrete` |
 * | 滞在時間、呼び出し → 着席 | 対数正規分布 | `logNormal` |
 * | ノーショー、退席の申告 | ベルヌーイ | `bernoulli` |
 *
 * **どの関数も `Rng` を引数で受け取る。** 自分では乱数を作らない。どの流れから
 * 引いたかを呼び出し側が決められるようにするためで、方針の比較（8.2）で共通
 * 乱数を使うにはこれが要る（`rng.ts`）。
 */

import type { DurationMs, Timestamp } from '../src/index.js';
import { minutes } from '../src/index.js';
import type { Rng } from './rng.js';

/** 値と、その重み。重みの合計は 1 でなくてよい（正規化する）。 */
export interface Weighted<T> {
  readonly value: T;
  readonly weight: number;
}

/**
 * 重みつきの離散分布から 1 つ選ぶ。
 *
 * 重みの合計で割ってから選ぶので、百分率でもそのまま書ける。重みが 0 以下の
 * 項目は選ばれない。候補が空なら `null`。
 */
export function discrete<T>(rng: Rng, choices: readonly Weighted<T>[]): T | null {
  const total: number = choices.reduce((sum, choice) => sum + Math.max(0, choice.weight), 0);
  if (total <= 0) return null;

  let remaining: number = rng.next() * total;
  for (const choice of choices) {
    remaining -= Math.max(0, choice.weight);
    if (remaining < 0) return choice.value;
  }
  return choices[choices.length - 1]?.value ?? null;
}

/**
 * 標準正規分布から 1 つ引く（Box-Muller 法）。
 *
 * 2 つの一様乱数から 1 つだけ作る。もう 1 つを取っておけば乱数を半分に減らせる
 * が、**状態を持つと「同じシードで同じ列」が呼び出しの順序に左右される**ので、
 * 取っておかない。速さより再現性を採る。
 */
export function standardNormal(rng: Rng): number {
  // 0 を避ける。log(0) は -Infinity になる。
  const u1: number = 1 - rng.next();
  const u2: number = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * 対数正規分布から 1 つ引く。
 *
 * 中央値とばらつき（σ）で指定する。滞在時間や「呼び出しから着席まで」のように、
 * **短い側に山があって長い側に裾を引く**時間はこの形になる。
 */
export function logNormal(rng: Rng, median: DurationMs, sigma: number): DurationMs {
  return median * Math.exp(sigma * standardNormal(rng));
}

/**
 * 中央値と 90 パーセンタイルから σ を求める。
 *
 * 全体プラン 8.1 は「呼び出し → 着席」を「中央値 2 分、p90 6 分」と書いている。
 * 対数正規分布では `p90 = median * exp(σ * z90)` なので、σ は対数比を z90 で
 * 割れば出る。**仕様に書かれた数をそのまま使えるようにするための変換**である。
 */
const Z90 = 1.2815515655446004;

export function sigmaFromP90(median: DurationMs, p90: DurationMs): number {
  if (median <= 0 || p90 <= median) return 0;
  return Math.log(p90 / median) / Z90;
}

/** 確率 `p` で真を返す。 */
export function bernoulli(rng: Rng, probability: number): boolean {
  return rng.next() < probability;
}

// ---- 到着（非定常ポアソン過程） ----

/** 15 分刻みの到着率。 */
export interface RateBucket {
  /** この区間の始まり（シミュレーション開始からの経過）。 */
  readonly from: DurationMs;
  /** 1 時間あたりの到着組数。 */
  readonly perHour: number;
}

const HOUR_MS: DurationMs = minutes(60);

/** 1 区間の長さ。8.1 の「15 分刻み」に対応する。 */
export const BUCKET_SPAN: DurationMs = minutes(15);

/**
 * 到着率が定義されている長さ。最後の区間の終わりまで。
 *
 * **受付時間はここから導く。** 別々に書くと、区間を足したときに受付時間を
 * 直し忘れ、最後の率がそのまま延長されてしまう。
 */
export function arrivalWindow(buckets: readonly RateBucket[]): DurationMs {
  const last = buckets[buckets.length - 1];
  return last === undefined ? 0 : last.from + BUCKET_SPAN;
}

/** その時刻に効いている到着率（組/時）。範囲の外は 0。 */
export function rateAt(buckets: readonly RateBucket[], elapsed: DurationMs): number {
  let current = 0;
  for (const bucket of buckets) {
    if (elapsed < bucket.from) break;
    current = bucket.perHour;
  }
  return elapsed < (buckets[0]?.from ?? 0) ? 0 : current;
}

/**
 * 非定常ポアソン過程の到着時刻を並べる（間引き法）。
 *
 * いちばん高い率で一様に候補を作り、その時刻の実際の率との比で受け入れる。
 * 区間ごとに指数分布を繋ぐより短く書けて、区間の境目の扱いを間違えにくい。
 *
 * **区間の外では到着しない。** 受付終了後の到着をモデル化したければ、率 0 の
 * 区間を足すのではなく `until` を延ばす。
 *
 * @param until ここまでの到着を返す（含まない）
 */
export function arrivalTimes(
  rng: Rng,
  buckets: readonly RateBucket[],
  until: DurationMs,
): readonly Timestamp[] {
  const peak: number = buckets.reduce((best, bucket) => Math.max(best, bucket.perHour), 0);
  if (peak <= 0) return [];

  const times: DurationMs[] = [];
  let at: DurationMs = buckets[0]?.from ?? 0;
  while (at < until) {
    // 率 `peak` の一様な過程から次の候補を作る。
    at += (-Math.log(1 - rng.next()) / peak) * HOUR_MS;
    if (at >= until) break;
    if (rng.next() < rateAt(buckets, at) / peak) times.push(Math.round(at));
  }
  return times;
}
