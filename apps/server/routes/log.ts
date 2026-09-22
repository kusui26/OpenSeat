/**
 * 記録に残すもの。
 *
 * **秘密は 1 つも出さない**（CLAUDE.md 7 章）。チケットの秘密パラメータ、座席
 * トークン、端末の匿名トークン、セッション、通知先 —— どれも、**エラーの文脈
 * 情報にも入れない。**
 *
 * ## だから、識別子ごと出さない
 *
 * 残すのは**道の形**（`/api/t/:ticket`）であって、通った URL ではない。URL には
 * `?k=`（秘密パラメータ）が乗っているし、伏せたつもりでも、**書き方を 1 か所
 * 変えた誰かが丸ごと出してしまう。** はじめから持たないほうが確かである。
 *
 * 困ったときに要るのは「どの入口が、どれくらいの速さで、どう答えたか」であって、
 * 誰の話かではない。それはイベントと監査ログ（PR 12）が持っている。
 */

import type { MiddlewareHandler } from 'hono';

/** 1 行の記録。**識別子も秘密も入らない。** */
export interface AccessRecord {
  readonly method: string;
  /** 道の形（`/api/t/:ticket`）。**通った URL ではない。** */
  readonly route: string;
  readonly status: number;
  readonly ms: number;
}

export type Sink = (record: AccessRecord) => void;

/** 既定の出し先。 */
export const toConsole: Sink = (record) => {
  console.log(`${record.method} ${record.route} ${String(record.status)} ${String(record.ms)}ms`);
};

/** 出入りを記録する。 */
export function accessLog(sink: Sink = toConsole, clock: () => number = Date.now): MiddlewareHandler {
  return async (c, next) => {
    const started: number = clock();
    await next();
    sink({
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
      ms: clock() - started,
    });
  };
}
