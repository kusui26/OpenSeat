/**
 * 要求から値を取り出す。
 *
 * **取り出すだけで、判断しない。** 足りないかどうかを決めるのはハンドラである。
 */

import { IdempotencyKey } from '@openseat/shared';
import type { Context } from 'hono';

/** 送り直しを見分ける鍵（9.4）。**画面が付ける。** */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * パスの断片。
 *
 * **道が一致して初めてハンドラが呼ばれる**ので、ここが空になることは無い。
 * 型のうえでは `undefined` がありうるので、空文字に倒して先へ渡す（引けなければ
 * 「見つからない」で断られる）。
 */
export function paramOf(c: Context, name: string): string {
  return c.req.param(name) ?? '';
}

export function idempotencyKeyOf(c: Context): string | null {
  const parsed = IdempotencyKey.safeParse(c.req.header(IDEMPOTENCY_HEADER));
  return parsed.success ? parsed.data : null;
}
