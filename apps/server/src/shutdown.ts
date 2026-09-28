/**
 * 止め方（開発プラン 9.13、[ADR-0019](../../../docs/adr/0019-where-to-run-it.md)）。
 *
 * **配信は自分からは終わらない。** `close` は答え終えていない接続を待つので、
 * 画面が 1 枚開いているだけで戻らない —— 手元で確かめると、配信を 1 本
 * つないだだけで、終了の合図から 15 秒たっても止まらなかった。本番では誰かが
 * 必ず画面を開いているので、**再デプロイのたびに置き場の強制終了を待つ**ことに
 * なり、そのあいだ止まり続け、記録も閉じられない。
 *
 * **受け付け中の要求には答え終えてもらい、そのあとで配信ごと切る。** 画面は
 * 切れたらつなぎ直す（散らしつき。ADR-0019）ので、切ってよい。途中で切られた
 * 要求も、同じ冪等キーで送り直せば二重には効かない（ADR-0015）。
 */

import type { ServerType } from '@hono/node-server';

/**
 * 受け付け中の要求に答え終えるのを待つ時間。**過ぎたら配信ごと切る。**
 *
 * 要求は数ミリ秒で終わるので、1 秒あれば足りる。**置き場の猶予より短く**
 * 保つこと（Railway の `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`、Docker の
 * `docker stop` は既定 10 秒）。
 */
export const SHUTDOWN_DRAIN_MS = 1_000;

/**
 * 新しい接続を断り、開いている接続が無くなったら `done` を呼ぶ。
 *
 * 開いているものが無ければ、待たずにすぐ呼ぶ。`drainMs` はテストが縮めるためにある。
 */
export function stopServing(
  server: ServerType,
  done: () => void,
  drainMs: number = SHUTDOWN_DRAIN_MS,
): void {
  const cut: NodeJS.Timeout = setTimeout(() => {
    cutAll(server);
  }, drainMs);
  server.close(() => {
    clearTimeout(cut);
    done();
  });
}

/** 開いている接続をすべて切る。HTTP/2 の口には無いので、あるときだけ。 */
function cutAll(server: ServerType): void {
  if ('closeAllConnections' in server) server.closeAllConnections();
}
