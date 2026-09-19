/**
 * 運用時間帯（全体プラン 7.14）。
 *
 * 「土日祝 11:00〜14:30、17:30〜19:30」のような設定を **データとして宣言し、
 * 純粋に評価する**だけの層である。状態を持たず、`VenueState` にも入らない。
 *
 * **UTC とローカル時刻の変換はここではしない。** core は時刻を UTC のミリ秒で
 * 受け取る設計なので（9.4）、タイムゾーンの解決は境界側の責務である。ここが
 * 受け取るのは **変換済みのローカル時刻**（曜日と、その日の 0 時からの分数）
 * だけで、施設が `Asia/Tokyo` でも `Asia/Taipei` でも同じ式で判定できる。
 *
 * ここで計算した「この営業回が終わる時刻」を `OPEN` コマンドに載せると、
 * **運用終了がほかの期限とまったく同じ仕組みで処理される**（`deadlines.ts`）。
 * 個別のタイマーを持たないので、再起動しても取りこぼさない（CLAUDE.md 3.4）。
 *
 * ```ts
 * // 境界側（Phase 2 のスケジューラ）の使い方
 * const local = toLocalTime(now, venue.timezone);      // 境界の仕事
 * const window = windowAt(venue.schedule, local);      // ここの仕事
 * if (window !== null) dispatch({ type: 'OPEN', closesAt: closesAtOf(now, local, window), by: 'staff' });
 * ```
 */

import { minutes, type DurationMs, type Timestamp } from './time.js';

/** 曜日。`Date.getDay()` と同じ並びにしてある（境界側の変換を素直にするため）。 */
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/** 1 日の分数。境界の値そのものではなく、判定の意味を名前で示すために置く。 */
export const MINUTES_PER_DAY = 24 * 60;

/**
 * 施設のローカル時刻。
 *
 * `minuteOfDay` は 0（0:00）から 1439（23:59）まで。**日付は持たない。**
 * 週の繰り返しだけを表す設定なので、日付があっても使い道が無い。
 */
export interface LocalTime {
  readonly weekday: Weekday;
  readonly minuteOfDay: number;
}

/**
 * 運用する時間帯 1 本。
 *
 * `toMin` は **その日のうち**に収める（0〜1440）。日をまたぐ運用（22:00〜翌 2:00）は
 * 2 本に分けて書く。1 本で表せるようにすると「いま何本目の窓か」の判定が
 * 一気に難しくなるうえ、フードコートに日またぎの運用は無い。
 */
export interface ManagedWindow {
  readonly days: readonly Weekday[];
  /** 開始（その日の 0 時からの分数）。 */
  readonly fromMin: number;
  /** 終了（同上）。`fromMin` より後であること。 */
  readonly toMin: number;
}

/** 運用時間帯の一覧（`managed_schedule`）。空なら、いつも運用外。 */
export type ManagedSchedule = readonly ManagedWindow[];

// ---- 判定 ----

/** その時刻を含む運用時間帯。無ければ `null`。 */
export function windowAt(schedule: ManagedSchedule, local: LocalTime): ManagedWindow | null {
  return (
    schedule.find(
      (window) =>
        window.days.includes(local.weekday) &&
        local.minuteOfDay >= window.fromMin &&
        local.minuteOfDay < window.toMin,
    ) ?? null
  );
}

/**
 * いま運用時間内か。
 *
 * **手動の切替はここでは見ない。** 7.14 が「スタッフの手動 ON/OFF を優先させる」
 * と書いているとおり、優先関係は状態（`operating`）の側で決まる。ここは
 * 「設定上どうか」だけを答える。
 */
export function isManaged(schedule: ManagedSchedule, local: LocalTime): boolean {
  return windowAt(schedule, local) !== null;
}

/** いまの営業回が終わるまでの時間。運用時間外なら `null`。 */
export function remainingToday(schedule: ManagedSchedule, local: LocalTime): DurationMs | null {
  const window = windowAt(schedule, local);
  return window === null ? null : minutes(window.toMin - local.minuteOfDay);
}

/**
 * いまの営業回が終わる時刻。運用時間外なら `null`。
 *
 * **これを `OPEN` コマンドに載せる。** 以降、運用終了は状態に書かれた絶対時刻と
 * `now` の比較だけで処理される。
 */
export function closesAtOf(
  now: Timestamp,
  local: LocalTime,
  schedule: ManagedSchedule,
): Timestamp | null {
  const remaining = remainingToday(schedule, local);
  return remaining === null ? null : now + remaining;
}

// ---- 検証 ----

export interface ScheduleProblem {
  /** 何本目の窓か（0 始まり）。 */
  readonly index: number;
  readonly message: string;
}

/**
 * 設定の妥当性。壊れた設定の扱いを判定側に負わせないための入口検査。
 *
 * `validatePolicy`（`domain/policy.ts`）と同じ形にしてある。
 */
export function validateSchedule(schedule: ManagedSchedule): readonly ScheduleProblem[] {
  return schedule.flatMap((window, index) => problemsIn(window).map((message) => ({ index, message })));
}

function problemsIn(window: ManagedWindow): readonly string[] {
  const problems: string[] = [];
  if (window.days.length === 0) problems.push('曜日が 1 つも指定されていない');
  if (!isMinuteOfDay(window.fromMin)) problems.push('開始が 0〜1440 の整数でない');
  if (!isMinuteOfDay(window.toMin)) problems.push('終了が 0〜1440 の整数でない');
  if (window.fromMin >= window.toMin) problems.push('終了が開始より後になっていない');
  return problems;
}

function isMinuteOfDay(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MINUTES_PER_DAY;
}
