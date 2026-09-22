/**
 * よそのサイトから書き込ませない（CSRF。CLAUDE.md 7 章）。
 *
 * ## 何を防ぐのか
 *
 * 攻撃者のページが、**利用者のブラウザに勝手に書き込みをさせる**こと。Cookie は
 * 行き先のサイトへ自動で付くので、Cookie だけで通る入口があると、フォームを 1 つ
 * 置くだけで他人の操作を起こせてしまう。
 *
 * OpenSeat では、端末の匿名トークンの控えを Cookie に置いている（9.8）。
 * **その控えで受付が通ってしまうと、身に覚えのない順番待ちが作られる。**
 *
 * ## トークンではなく、`Origin` を照合する
 *
 * よくある手は、画面に隠しトークンを配って送り返させる方法である。ここでは採らない。
 *
 * - **状態を持たずに済む。** トークンを配る入口も、覚えておく場所も要らない
 * - **`Origin` は攻撃者が書き換えられない。** ブラウザが付けるヘッダで、
 *   JavaScript から差し替える手段が無い
 * - 主要なブラウザは、**書き込みの要求に必ず `Origin` を付ける**
 *
 * 付いていない要求（ブラウザ以外の呼び出し）は通す。**Cookie を持たない相手を
 * 締め出しても、守れるものが増えない。**
 *
 * **読み取りは見ない。** 読むだけの要求は状態を変えないし、`?k=` を知らなければ
 * 何も見えない。
 */

import type { MiddlewareHandler } from 'hono';
import { bundleFor, translateError } from '@openseat/shared';

/** 状態を変える要求。**ここだけを見る。** */
const WRITES: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * よそから来た書き込みを断る。
 *
 * **比べるのは名前（ホスト）だけである。** 置き場によっては、外から見える方式
 * （https）と中で受ける方式（http）が違う。方式まで比べると、まともな要求まで
 * 断ってしまう。
 */
export function sameOriginOnly(): MiddlewareHandler {
  return async (c, next) => {
    if (!WRITES.includes(c.req.method)) return next();

    const origin: string | undefined = c.req.header('origin');
    if (origin === undefined || hostOf(origin) === c.req.header('host')) return next();

    const bundle = bundleFor('ja');
    return c.json({ code: 'FORBIDDEN', message: translateError(bundle, 'FORBIDDEN'), retryAfterSec: null }, 403);
  };
}

/** `https://example.com:443` → `example.com:443`。読めなければ空にする。 */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return '';
  }
}
