/**
 * 断りを HTTP に写す。
 *
 * **写し方は表が決める**（`packages/shared` の `ERROR_STATUS`）。ハンドラごとに
 * 状態コードを選ばせると、同じ理由が 400 だったり 409 だったりして、呼ぶ側が
 * 分岐できなくなる。
 *
 * **文言も `packages/shared` から引く。** `core` の `describe` は開発者が読む一文で、
 * 席の状態など利用者に意味のない情報を含むことがある。**そのまま外に出さない。**
 */

import type { Rejection } from '@openseat/core';
import {
  apiErrorFor,
  bundleFor,
  ERROR_STATUS,
  translateError,
  type ApiErrorCode,
  type Bundle,
  type ProblemResponse,
} from '@openseat/shared';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** `core` の拒否を返す。**欠陥は `INTERNAL` に潰れる**（`apiErrorFor`）。 */
export function rejected(c: Context, rejection: Rejection, locale: string): Response {
  return problem(c, apiErrorFor(rejection), locale);
}

/** 境界が出す断りを返す。 */
export function problem(
  c: Context,
  code: ApiErrorCode,
  locale: string,
  retryAfterSec: number | null = null,
): Response {
  const bundle: Bundle = bundleFor(locale);
  const body: ProblemResponse = { code, message: translateError(bundle, code), retryAfterSec };
  return c.json(body, statusOf(code));
}

/**
 * 表の値をそのまま使う。
 *
 * `ERROR_STATUS` は `as const` で宣言してあるので、**取り出した値の型は
 * `400 | 401 | ... | 500` という並び**になる。写し替える必要が無い ——
 * 表に無い状態コードは、そもそも書けない。
 */
function statusOf(code: ApiErrorCode): ContentfulStatusCode {
  return ERROR_STATUS[code];
}
