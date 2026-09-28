/**
 * 止め方（開発プラン 9.13）。
 *
 * **本物の口を開く。** 確かめたいのは「開いている接続があるときに `close` が
 * どう振る舞うか」で、これは Node の HTTP サーバそのものの性質だからである。
 *
 * 確かめたいのは 3 つ。
 *
 * 1. **配信が開いていても止まる**（開いたままだと、置き場の強制終了まで戻らない）
 * 2. **受け付け中の要求には、答え終えてから止まる**（途中で切らない）
 * 3. **開いているものが無ければ、待たずに止まる**（再デプロイを無駄に長くしない）
 */

import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { get, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { stopServing } from './shutdown.js';

/** 待つ時間を縮めて試す。**形は本番の 1 秒と同じまま、速く回す。** */
const DRAIN_MS = 300;

/** 要求に答えるまでの時間。**待つ時間より短い**ので、切られずに答え終える。 */
const SLOW_MS = 100;

/** タイマーは数ミリ秒早く鳴ることがある（ループの時刻を丸めて持つため）。 */
const TIMER_SLACK_MS = 20;

/** 遅い機械でも落ちない幅。**止まらない（強制終了を待つ）ことは確実に捕まえる。** */
const SETTLE_MS = 2_000;

/** 1 度だけ鳴る合図。 */
interface Signal {
  readonly fire: () => void;
  readonly fired: Promise<void>;
}

function signal(): Signal {
  const box: { fire: () => void } = { fire: () => undefined };
  const fired = new Promise<void>((resolve) => {
    box.fire = resolve;
  });
  return { fire: () => { box.fire(); }, fired };
}

/** 開きっぱなしの配信と、少し時間のかかる要求。 */
function app(arrived: Signal): Hono {
  const hono = new Hono();
  hono.get('/stream', (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'venue', data: '{}' });
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
      });
    }),
  );
  hono.get('/slow', async (c) => {
    arrived.fire();
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    return c.text('answered');
  });
  return hono;
}

let opened: ServerType | null = null;

/** 口を開く。`/slow` に要求が届いたら `arrived` が鳴る。 */
function listen(arrived: Signal = signal()): Promise<{ server: ServerType; base: string }> {
  return new Promise((resolve) => {
    const server: ServerType = serve(
      { fetch: app(arrived).fetch, port: 0, hostname: '127.0.0.1' },
      (info: AddressInfo) => {
        resolve({ server, base: `http://127.0.0.1:${String(info.port)}` });
      },
    );
    opened = server;
  });
}

/** 止めて、止まり終えるまでの時間を返す。 */
function stop(server: ServerType): Promise<number> {
  const started: number = performance.now();
  return new Promise((resolve) => {
    stopServing(server, () => { resolve(performance.now() - started); }, DRAIN_MS);
  });
}

/** 配信につなぎ、1 通目が届いたら返す。**切られたら `cut` が解ける。** */
function openStream(url: string): Promise<{ readonly cut: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response: IncomingMessage) => {
      const cut = new Promise<void>((done) => {
        response.on('close', done);
        // 切られると `error`（aborted）も出る。**聞いておかないと落ちる。**
        response.on('error', () => { done(); });
      });
      response.once('data', () => { resolve({ cut }); });
    });
    request.on('error', reject);
  });
}

afterEach(() => {
  if (opened !== null && 'closeAllConnections' in opened) opened.closeAllConnections();
  opened?.close(() => undefined);
  opened = null;
});

describe('終了の合図で止める', () => {
  it('配信が開いていても、待つ時間を過ぎたら切って止まる', async () => {
    const { server, base } = await listen();
    const stream = await openStream(`${base}/stream`);

    const tookMs: number = await stop(server);
    await stream.cut;

    // **待つ時間のあいだは止まっていない** —— 配信が `close` を引き留めていた証拠。
    expect(tookMs).toBeGreaterThanOrEqual(DRAIN_MS - TIMER_SLACK_MS);
    expect(tookMs).toBeLessThan(DRAIN_MS + SETTLE_MS);
  });

  it('受け付け中の要求には、答え終えてから止まる', async () => {
    const arrived: Signal = signal();
    const { server, base } = await listen(arrived);
    const answer: Promise<string> = fetch(`${base}/slow`).then((response) => response.text());
    await arrived.fired;

    const tookMs: number = await stop(server);

    expect(await answer).toBe('answered');
    expect(tookMs).toBeLessThan(DRAIN_MS + SETTLE_MS);
  });

  it('開いているものが無ければ、待たずに止まる', async () => {
    const { server } = await listen();

    const tookMs: number = await stop(server);

    expect(tookMs).toBeLessThan(DRAIN_MS);
  });
});
