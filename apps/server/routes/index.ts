/**
 * ルートの組み立て。
 *
 * **ここは Hono に道を教えるだけである。** ハンドラは [`Deps`](deps.ts) しか
 * 知らないので、**永続化にも ORM にも触らない**（CLAUDE.md 3.1、`pnpm check:arch`）。
 * `Deps` を実際の DB から作るのは、境界の入口（`src/api.ts`）の仕事である。
 *
 * ## どの返しにも付く守り（CLAUDE.md 7 章）
 *
 * | | 何を防ぐか |
 * |---|---|
 * | セキュリティヘッダ | **`Referrer-Policy: no-referrer` がとくに効く。** チケットの URL には秘密パラメータ（`?k=`）が乗っているので、そこから外部のリンクを踏まれると、**参照元として秘密が相手のログに残る**（9.8） |
 * | `Origin` の照合 | よそのサイトからの書き込み（CSRF）。**トークンを配らずに済む**理由は [`origin.ts`](origin.ts) にある |
 * | 出入りの記録 | **秘密も識別子も出さない。** 残すのは道の形だけ（[`log.ts`](log.ts)） |
 */

import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { Deps } from './deps.js';
import { accessLog, type Sink } from './log.js';
import { sameOriginOnly } from './origin.js';
import { ticketRoutes } from './tickets.js';
import { venueRoutes } from './venue.js';

/**
 * API の道の始まり。**画面の道と混ざらない印**である（`src/web.ts`）。
 *
 * 契約（`packages/shared` の `ROUTES`）もこの下に並ぶ。
 */
export const API_PREFIX = '/api/';

/** 利用者の API（9.7 の 1〜3・6）。座席 QR は PR 10、ボードは PR 11。 */
export function api(deps: Deps, sink?: Sink): Hono {
  const app = new Hono();
  // **守りは API の道にだけ付ける。** このアプリは画面と同じ入口に載るので
  // （9.2）、`*` に付けると画面の返しにまで API 向けの CSP がかかる。
  const under = `${API_PREFIX}*`;
  app.use(under, headers());
  app.use(under, sameOriginOnly());
  app.use(under, sink === undefined ? accessLog() : accessLog(sink, deps.clock));
  app.route('/', ticketRoutes(deps));
  app.route('/', venueRoutes(deps));
  return app;
}

/**
 * どの返しにも付ける守り。
 *
 * - **`no-referrer`**: チケット URL の秘密パラメータを、外部へ漏らさない（9.8）
 * - **`nosniff`**: 返した種別以外に解釈させない
 * - **枠に入れさせない**: 別のサイトに埋め込まれた偽の画面を作らせない
 *
 * **CSP はここでは何も許さない。** API が返すのは JSON だけで、そこから読み込む
 * ものは 1 つも無い。**画面の CSP は別である**（`src/web.ts` の `appSecurity`）。
 * 万一ここから HTML が返るようなことがあっても、何も動かないのが正しい。
 */
function headers(): ReturnType<typeof secureHeaders> {
  return secureHeaders({
    referrerPolicy: 'no-referrer',
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    crossOriginOpenerPolicy: 'same-origin',
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  });
}
