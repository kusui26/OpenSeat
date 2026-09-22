/**
 * 筋書きが世界を動かすための口。**テスト専用で、コンテナに入らない。**
 *
 * 2 つしかない。
 *
 * | 口 | 現実でいうと |
 * |---|---|
 * | `POST /__test/clock` | **時間が経つこと。** 期限切れを待たずに再現する（9.12） |
 * | `GET /__test/tables` | **卓の上の QR を見ること。** 席番号と、そこに貼ってあるトークン |
 *
 * `/__test/tables` を置いてあるのは、**トークンが外に出ない**からである（9.8。
 * チケットの姿は席番号までしか返さない）。現実の人は卓上の QR を読み取るが、
 * 筋書きには読み取る目が無いので、ここで代わりに見る。**PR 10 で座席 QR の
 * 画面が入ったら、筋書きはその URL を直に開くようになる。**
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '@openseat/server/dist/db/client.js';
import { tables } from '@openseat/server/dist/db/schema.js';

/** 進められる時計。 */
export interface Clock {
  readonly now: () => number;
  readonly advance: (ms: number) => void;
}

export interface ControlParams {
  readonly clock: Clock;
  /** 刻みを 1 回。**進めたぶんの期限を、その場で片づける。** */
  readonly tick: () => Promise<void>;
  readonly db: Db;
  readonly venueId: string;
}

export function controlRoutes(params: ControlParams): Hono {
  const app = new Hono();

  /**
   * 時間を進める。
   *
   * **戻ったときには、期限がすべて片づいている。** 進めるだけでは何も起きない
   * （期限を見るのは刻みである）ので、ここで 1 回まわしてから返す。そうしないと
   * 筋書きが「もう反映されたか」を当て推量で待つことになる。
   */
  app.post('/__test/clock', async (c) => {
    const body: unknown = await c.req.json();
    const ms: number = advanceIn(body);
    params.clock.advance(ms);
    await params.tick();
    return c.json({ now: params.clock.now() });
  });

  /** 卓の上の QR。**席番号と、そこに貼ってあるトークン。** */
  app.get('/__test/tables', (c) => {
    const rows = params.db
      .select({ label: tables.label, token: tables.token })
      .from(tables)
      .where(eq(tables.venueId, params.venueId))
      .all();
    return c.json({ tables: rows });
  });

  return app;
}

/** 進める幅。**読めなければ落とす**（筋書きの誤りを黙って進めない）。 */
function advanceIn(body: unknown): number {
  if (typeof body !== 'object' || body === null || !('advanceMs' in body)) {
    throw new Error('advanceMs がありません');
  }
  const ms: unknown = body.advanceMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    throw new Error(`advanceMs が数ではありません: ${String(ms)}`);
  }
  return ms;
}
