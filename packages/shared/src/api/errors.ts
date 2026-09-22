/**
 * 断りの返し方。
 *
 * **機械が読む `code` と、人が読む `message` の両方を返す。** 画面は `code` で
 * 分岐し、`message` をそのまま出せる。外部連携（9.7）は `code` だけを見ればよい。
 *
 * 文言は `code` を鍵にして [i18n](../i18n/index.ts) が作る。**`core` の
 * `Rejection.describe` は開発者向けの一文なので、そのまま外に出さない。**
 */

import { isDefect, REJECTION_CODES, type Rejection } from '@openseat/core';
import { z } from 'zod';

/**
 * 境界だけが出す理由。ドメインの判断ではないので `core` には無い。
 *
 * | コード | いつ |
 * |---|---|
 * | `INVALID_REQUEST` | Zod の検証を通らなかった |
 * | `UNAUTHORIZED` | セッションが無い（PR 12） |
 * | `NOT_FOUND` | その URL の施設・チケット・席が無い |
 * | `RATE_LIMITED` | 受付の回数制限（7.16 の `join_rate_limit_per_hour`） |
 * | `INTERNAL` | 上記のどれでもない。**理由を外に出さない** |
 */
export const BOUNDARY_ERROR_CODES = [
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type BoundaryErrorCode = (typeof BOUNDARY_ERROR_CODES)[number];

/**
 * API が返しうる理由のすべて。
 *
 * **`core` の拒否をそのまま含む。** 境界で言い換えると、同じことを 2 か所で
 * 名づけることになる。
 *
 * **`FORBIDDEN` は `core` の側にある。** 権限表（CLAUDE.md 3.2(4)）はドメインの
 * 宣言で、境界はそれを評価しないためである（PR 3）。
 */
export const API_ERROR_CODES = [...REJECTION_CODES, ...BOUNDARY_ERROR_CODES] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

/**
 * 断りの本体。
 *
 * **`core` の `describe` は入らない。** 開発者向けの一文で、席の状態など
 * 利用者に意味のない情報を含むことがあるためである。
 */
export const ProblemResponse = z.object({
  code: ApiErrorCodeSchema.describe('機械が分岐する識別子'),
  message: z.string().describe('利用者に見せる一文。施設のロケールで作られる'),
  /** `RATE_LIMITED` のときだけ入る。ほかは `null`。 */
  retryAfterSec: z.int().min(0).nullable(),
}).meta({ id: 'Problem' });

export type ProblemResponse = z.infer<typeof ProblemResponse>;

/**
 * どの理由が、どの HTTP のステータスになるか。
 *
 * **表として宣言する。** ハンドラごとに選ばせると、同じ理由が 400 だったり
 * 409 だったりして、呼ぶ側が分岐できなくなる（CLAUDE.md 3.2）。
 *
 * 考え方は 3 つだけである。
 *
 * - **利用者の入力が悪い** → `400`
 * - **いまはその操作ができない**（状態・時間・混雑） → `409`
 * - **こちらの落ち度** → `500`
 */
export const ERROR_STATUS = {
  // 入力が悪い
  PARTY_SIZE_INVALID: 400,
  PARTY_TOO_SMALL: 400,
  PARTY_TOO_LARGE: 400,
  REASON_REQUIRED: 400,
  INVALID_REQUEST: 400,

  // 見つからない
  TICKET_NOT_FOUND: 404,
  TABLE_NOT_FOUND: 404,
  NOT_FOUND: 404,

  // 資格が足りない
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  STAFF_ONLY: 403,


  // いまはできない
  TICKET_ALREADY_EXISTS: 409,
  QUEUE_FULL: 409,
  JOIN_CLOSED: 409,
  NOT_ALLOWED_IN_STATE: 409,
  BLOCKED_BY_GUARD: 409,
  NO_CODE_AVAILABLE: 409,

  RATE_LIMITED: 429,

  // こちらの落ち度
  ACTOR_MISMATCH: 500,
  GUARD_NOT_IMPLEMENTED: 500,
  CLOCK_WENT_BACKWARD: 500,
  INVARIANT_VIOLATED: 500,
  INTERNAL: 500,
} as const satisfies Record<ApiErrorCode, number>;

/**
 * `core` の拒否を、外に出す理由に変える。
 *
 * **欠陥は潰す。** `INVARIANT_VIOLATED` と `CLOCK_WENT_BACKWARD` は入力の誤りでは
 * なく実装の誤りで、利用者に伝えても打つ手がない。外には `INTERNAL` だけを出し、
 * 中では記録して調査する（`core` の `isDefect`）。
 */
export function apiErrorFor(rejection: Rejection): ApiErrorCode {
  return isDefect(rejection) ? 'INTERNAL' : rejection.code;
}
