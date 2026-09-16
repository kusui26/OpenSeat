/**
 * 時刻の扱い。
 *
 * `core` は時刻を **生成しない**。`Date.now()` を呼ばず、必ず引数で受け取る。
 * これはサーバとシミュレータとテストで同じコードを動かすための制約である
 * （ADR-0004、CLAUDE.md 3.4）。
 */

/** UTC のミリ秒。表示のためのタイムゾーン変換は境界側の責務。 */
export type Timestamp = number;

/** 経過時間のミリ秒。 */
export type DurationMs = number;

export const SECOND_MS: DurationMs = 1_000;
export const MINUTE_MS: DurationMs = 60 * SECOND_MS;

/** 分をミリ秒に変換する。運用パラメータは分単位で表現されるため頻用する。 */
export function minutes(count: number): DurationMs {
  return count * MINUTE_MS;
}

/** 秒をミリ秒に変換する。 */
export function seconds(count: number): DurationMs {
  return count * SECOND_MS;
}

/** 基準時刻に経過時間を加えた時刻を返す。 */
export function after(at: Timestamp, elapsed: DurationMs): Timestamp {
  return at + elapsed;
}

/** 期限を過ぎているかを判定する。期限ちょうどは「過ぎていない」とする。 */
export function hasPassed(deadline: Timestamp, now: Timestamp): boolean {
  return now > deadline;
}

/** 期限までの残り時間。過ぎている場合は 0 を返す（負の値を外に出さない）。 */
export function remaining(deadline: Timestamp, now: Timestamp): DurationMs {
  const left: DurationMs = deadline - now;
  return left > 0 ? left : 0;
}

/** 基準時刻からの経過時間。未来の時刻を渡された場合は 0 を返す。 */
export function elapsedSince(from: Timestamp, now: Timestamp): DurationMs {
  const passed: DurationMs = now - from;
  return passed > 0 ? passed : 0;
}
