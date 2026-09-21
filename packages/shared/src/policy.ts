/**
 * 運用パラメータ（7.16 の 29 キー）の契約。
 *
 * **値は持たない。** 既定値は `core` の `DEFAULT_POLICY` が唯一の出典で、ここは
 * それを通すだけである（CLAUDE.md 4 章の DRY）。ここにあるのは「外から来た設定を
 * 受け取るときの形」だけである。
 *
 * ## 無限大をどう運ぶか
 *
 * `fairnessOverrideMin` は `Infinity` を取りうる（「純粋な best fit」の指定。7.16）。
 * **JSON は無限大を表せない。** `JSON.stringify(Infinity)` は `null` になり、
 * 黙って別の設定に変わる。だから**線の上では文字列 `"Infinity"` で運ぶ**。
 * 変換はこのファイルの 2 つの関数に閉じている。
 */

import { DEFAULT_POLICY, NO_SHOW_POLICIES, TABLE_ORDER_KEYS, TIME_LIMIT_MODES, type Policy } from '@openseat/core';
import { z } from 'zod';
import { Minutes, PartySize } from './values.js';

/**
 * 既定の運用パラメータ（10.3 のプリセット「標準」）。
 *
 * **再輸出しているだけである。** 施設を作る側が `core` と `shared` の両方を
 * 読まずに済むようにするためで、値は `core` の宣言そのままである。
 */
export const DEFAULT_SETTINGS: Policy = DEFAULT_POLICY;

/**
 * 分、または「上限なし」。
 *
 * **`"Infinity"` は文字列で運ぶ。** 数として送ると JSON が落とす（上記）。
 */
export const UnboundedMinutes = z.union([z.number().min(0), z.literal('Infinity')]);

export type UnboundedMinutes = z.infer<typeof UnboundedMinutes>;

const UNBOUNDED = 'Infinity';

export function toMinutes(value: UnboundedMinutes): number {
  return value === UNBOUNDED ? Number.POSITIVE_INFINITY : value;
}

export function fromMinutes(value: number): UnboundedMinutes {
  return Number.isFinite(value) ? value : UNBOUNDED;
}

/**
 * 7.16 の 29 キー。
 *
 * **並びは 7.16 の表と同じにしてある。** 表を見ながら読めるようにするためで、
 * 片方に足したときにもう片方が見つけやすい。
 *
 * これは中間の形で、外には出さない。線の上を通るのは下の `SettingsWire` である。
 */
const SHAPE = z.object({
  // 受付（7.5）
  maxPartySize: PartySize.nullable(),
  maxQueueLength: z.int().min(1),
  joinRateLimitPerHour: z.int().min(1),
  joinCutoffBeforeCloseMin: Minutes,
  longWaitConfirmMin: Minutes,

  // 割当（7.6）
  fairnessOverrideMin: z.number().min(0),
  tableOrder: z.array(z.enum(TABLE_ORDER_KEYS)).min(1),
  allowTableSwap: z.boolean(),
  turnoverMin: Minutes,

  // 呼び出しとホールド（7.7）
  holdMin: Minutes.min(1),
  holdReminderBeforeMin: Minutes,
  holdExtensionMin: Minutes,
  maxExtensions: z.int().min(0),
  noShowPolicy: z.enum(NO_SHOW_POLICIES),

  // 保留と放置（7.7、7.9）
  pauseStepMin: Minutes.min(1),
  pauseMaxTotalMin: Minutes,
  ticketMaxAgeMin: Minutes.min(1),
  abandonTimeoutMin: Minutes.min(1),

  // 着席時間の上限（7.10）
  timeLimitMode: z.enum(TIME_LIMIT_MODES),
  timeLimitMin: Minutes.min(1),
  limitOnlyWhenWaiting: z.boolean(),
  overstayGraceMin: Minutes,

  // 整合性の回復（7.11）
  stillHerePromptMin: Minutes.min(1),
  stillHereTimeoutMin: Minutes.min(1),
  assignNeedsCheck: z.boolean(),
  unknownOccupancyToCheckMin: Minutes.min(1),
  needsCheckAutoFreeMin: Minutes.min(1).nullable(),

  // 待ち時間の推定（7.13）
  assumedStayMin: Minutes.min(1),
  etaBucketMin: Minutes.min(1),
});

/**
 * 線の上を通る運用パラメータ。
 *
 * **`fairnessOverrideMin` だけが形を変える。** ほかは `core` の `Policy` と同じで、
 * 変換も 1 か所で済む（下の 2 つの関数が、そこだけを差し替えている）。
 */
export const SettingsWire = SHAPE.extend({ fairnessOverrideMin: UnboundedMinutes });

export type SettingsWire = z.infer<typeof SettingsWire>;

/**
 * 受け取った設定を `core` の型にする。
 *
 * **この関数が型の一致を見張っている。** `Policy` にキーが増えたら、返り値が
 * `Policy` を満たさなくなってここが落ちる。
 */
export function toPolicy(wire: SettingsWire): Policy {
  return { ...wire, fairnessOverrideMin: toMinutes(wire.fairnessOverrideMin) };
}

/**
 * 設定を線の上の形にする。
 *
 * 並びを写し直しているのは、`core` 側が読み取り専用の配列で持っているためである
 * （`.readonly()` を契約に付けない理由は `values.ts` の `Tags` にある）。
 */
export function toWire(policy: Policy): SettingsWire {
  return {
    ...policy,
    fairnessOverrideMin: fromMinutes(policy.fairnessOverrideMin),
    tableOrder: [...policy.tableOrder],
  };
}

/**
 * 既定値を、線の上の形で。
 *
 * **こちらも型の一致を見張っている。** `Policy` のキーが `SHAPE` に無ければ、
 * この代入が落ちる。
 */
export const DEFAULT_SETTINGS_WIRE: SettingsWire = toWire(DEFAULT_POLICY);
