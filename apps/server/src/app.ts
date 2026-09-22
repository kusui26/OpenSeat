/**
 * 入口の組み立て。**どの道を誰が受け持つかの、唯一の答え。**
 *
 * [`main.ts`](main.ts) から切り出してある。あちらは読み込んだだけで記録を開き
 * ポートを掴むので、**テストから同じものを組み立てられない。** 順序に意味が
 * ある以上（下記）、確かめられない形に置いてはならない。
 *
 * ## 載せる順序
 *
 * | | 何を受け持つか | 順序に意味はあるか |
 * |---|---|---|
 * | `/healthz` | 監視と通し確認 | **ある。** 画面より先でなければならない |
 * | 画面 | `/api/` 以外のすべて（9.2） | —— |
 * | API と配信 | `/api/` の下（9.7、9.5） | 無い。画面が `/api/` に触れない |
 *
 * **`/healthz` が先でなければならない理由。** 画面はどの道も 1 枚目に落とす
 * （SPA）。あとに置くと、ブラウザから `/healthz` を開いたとき（`Accept:
 * text/html`）に健康の答えではなく画面が返る。**監視の目が塞がれていることに、
 * 誰も気づけない。**
 */

import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { Timestamp } from '@openseat/core';
import type { Db } from '../db/client.js';
import type { Hub } from '../stream/hub.js';
import type { Registry } from '../venue/registry.js';
import { userApi } from './api.js';

/**
 * 健康の答え。
 *
 * **`ok` が返しの番号を決める。** 施設が読めないまま 200 を返すと、壊れた
 * コンテナに人が案内され続ける。
 */
export interface Health {
  readonly ok: boolean;
  readonly [key: string]: unknown;
}

export interface AppParams {
  readonly db: Db;
  readonly registry: Registry;
  readonly clock: () => Timestamp;
  /** 組み上がった画面（[`webApp`](web.ts)）。**無ければ配らない。** */
  readonly web: Hono | null;
  /** 配信（9.5）。**変化をここへ渡すのは `main.ts`。** */
  readonly hub: Hub;
  readonly health: (now: Timestamp) => Health;
}

export function buildApp(params: AppParams): Hono {
  const app = new Hono();
  mountHealth(app, params);
  if (params.web !== null) app.route('/', params.web);
  app.route(
    '/',
    userApi({ db: params.db, registry: params.registry, clock: params.clock, hub: params.hub }),
  );
  return app;
}

/**
 * 健康の答え（CLAUDE.md 8 の監視、`infra/smoke.sh`）。
 *
 * **秘密は載せない**（CLAUDE.md 7）。何を載せるかは `main.ts` が決める。
 */
function mountHealth(app: Hono, params: AppParams): void {
  // 画面と API はそれぞれ自分の守りを付ける。ここは自分で付ける。
  app.use('/healthz', secureHeaders({ referrerPolicy: 'no-referrer', xFrameOptions: 'DENY' }));
  app.get('/healthz', (c) => {
    const report: Health = params.health(params.clock());
    return c.json(report, report.ok ? 200 : 503);
  });
}
