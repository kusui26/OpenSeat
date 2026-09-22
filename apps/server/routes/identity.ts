/**
 * 誰が呼んでいるか（9.8）。
 *
 * **アカウントは無い。** 利用者を見分けるのは 2 つだけである。
 *
 * | | 何を示すか | どこに乗るか |
 * |---|---|---|
 * | 端末の匿名トークン | **同じ端末か。** 受付の回数制限に使う | ヘッダ（無ければ Cookie） |
 * | チケットの秘密パラメータ | **そのチケットの本人か** | `?k=` |
 *
 * **氏名も電話番号も取らない**（CLAUDE.md 7 章）。
 *
 * ## CSRF について
 *
 * **いまのところ、Cookie だけで状態を変えられる入口は 1 つも無い。** 本人の操作は
 * `?k=` を要り、受付はヘッダの匿名トークンを見る。どちらも**他所のサイトからは
 * 付けられない**（Cookie のように自動では飛ばない）ので、偽造する足場が無い。
 *
 * **Cookie は控えである。** `localStorage` が消えた端末が、自分のチケットを
 * 見つけ直すためだけに置く（9.8）。**Cookie だけを見て状態を変えない。**
 *
 * セッション（PR 12）が入ると事情が変わる。**あちらは CSRF の手当てが要る。**
 */

import { ANONYMOUS, ticketOwner, type Actor } from '@openseat/core';
import { ClientToken } from '@openseat/shared';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { hashOf, matches, newToken } from './secrets.js';

/** 匿名トークンを運ぶヘッダ。**他所のサイトからは付けられない。** */
export const CLIENT_HEADER = 'x-openseat-client';

/** 匿名トークンの控えを置く Cookie（9.8）。 */
export const CLIENT_COOKIE = 'openseat_client';

/** 控えを置いておく期間。実証実験は 4 日間である（12.2）。 */
const COOKIE_MAX_AGE_SEC = 7 * 24 * 60 * 60;

/**
 * この呼び出しを出した端末。
 *
 * **ヘッダを先に見る。** Cookie は控えで、`localStorage` を消した端末のためにある。
 * 無ければ作って、控えを返す。
 */
export function clientTokenOf(c: Context): string {
  const sent: string | undefined = c.req.header(CLIENT_HEADER) ?? getCookie(c, CLIENT_COOKIE);
  const parsed = ClientToken.safeParse(sent);
  return parsed.success ? parsed.data : newToken();
}

/**
 * 端末に控えを渡す。
 *
 * **`SameSite=Lax`。** 他所のサイトからの書き込みには乗らない。`HttpOnly` には
 * しない —— 画面が `localStorage` と突き合わせて読む必要がある（9.8）。
 */
export function keepClientToken(c: Context, token: string): void {
  setCookie(c, CLIENT_COOKIE, token, {
    path: '/',
    maxAge: COOKIE_MAX_AGE_SEC,
    sameSite: 'Lax',
    secure: c.req.url.startsWith('https://'),
    httpOnly: false,
  });
}

/** 保存する形。**生の値はここから先へ行かない。** */
export function clientHashOf(c: Context): string {
  return hashOf(clientTokenOf(c));
}

/**
 * そのチケットの本人か。
 *
 * **合わなければ匿名として扱う。** 「合わない」と伝えるより、**できることが
 * 何も無い実行者**にしてしまうほうが安全である。断りは権限表が出す（ADR-0014）。
 */
export function actorFor(c: Context, ticketId: string, storedHash: string | null): Actor {
  const given: string | undefined = c.req.query('k');
  return matches(given ?? null, storedHash) ? ticketOwner(ticketId) : ANONYMOUS;
}
