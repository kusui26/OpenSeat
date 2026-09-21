/**
 * ルート（Hono）。
 *
 * **ハンドラが書いてよいのは 5 行だけ**という CLAUDE.md 3.1 の形を、スパイクでも
 * 守る。入力の検証 → 実行者の特定 → コマンドの組み立て → モデルへ委譲 → 整形。
 * ここに `if (ticket.state === 'CALLED')` のような業務判断が現れたら設計の誤りで、
 * それは Phase 2 で本物を書くときに効いてくる。
 *
 * **Phase 2 で足りないもの**（ここでは作らない。Phase 1 プラン 11 章）: Zod の
 * API 契約、権限表、冪等キー、認証、レート制限、利用者の匿名トークン。
 * 実行者はすべて `user` 固定で、**誰でも他人のチケットを動かせる**。
 */

import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Command, Timestamp } from '@openseat/core';
import { renderPage } from './page.js';
import type { Hub } from './hub.js';
import type { Store } from './store.js';
import type { Applied, Venue } from './venue.js';

export interface Deps {
  readonly venue: Venue;
  readonly store: Store;
  readonly hub: Hub;
  readonly now: () => Timestamp;
  readonly newId: () => string;
  readonly startedAt: Timestamp;
  readonly version: string;
}

/** 受け付ける最大人数。画面の `max` と揃える。 */
const MAX_PARTY_SIZE = 6;

export function createApp(deps: Deps): Hono {
  const app = new Hono();
  addReads(app, deps);
  addWrites(app, deps);
  addStream(app, deps);
  return app;
}

/** 読むだけの入口。 */
function addReads(app: Hono, deps: Deps): void {
  app.get('/healthz', (c) => c.json({ ok: true, inputs: deps.store.size, clients: deps.hub.size }));
  app.get('/', (c) => c.html(page(deps)));
  app.get('/api/state', (c) => c.json(deps.venue.state));
}

/**
 * 状態を変える入口。**どれも 5 行の形を守る**（CLAUDE.md 3.1）。
 * 入力の検証 → コマンドの組み立て → モデルへ委譲 → 整形。
 */
function addWrites(app: Hono, deps: Deps): void {
  app.post('/join', async (c) => {
    const partySize: number | null = toPartySize((await c.req.parseBody())['partySize']);
    if (partySize === null) return c.text('人数は 1〜6 の整数です', 400);
    return settle(c, deps, deps.venue.dispatch(joinCommand(deps, partySize), deps.now()));
  });

  app.post('/tickets/:ticketId/check-in', async (c) => {
    const tableId: string | null = toText((await c.req.parseBody())['tableId']);
    if (tableId === null) return c.text('席が指定されていません', 400);
    const command: Command = { type: 'CHECK_IN', ticketId: c.req.param('ticketId'), tableId };
    return settle(c, deps, deps.venue.dispatch(command, deps.now()));
  });

  app.post('/tickets/:ticketId/check-out', (c) => {
    const command: Command = { type: 'CHECK_OUT', ticketId: c.req.param('ticketId'), by: 'user' };
    return settle(c, deps, deps.venue.dispatch(command, deps.now()));
  });
}

/**
 * 開きっぱなしの接続。**15 秒ごとに空の行を送る**ので、途中の経路が
 * 無通信で切るなら、そこで切れたことが分かる。
 *
 * これを置いてあるのは、**長い接続が Railway のプロキシ越しに保てるか**を、
 * 依存を 1 つも足さずに確かめるため（9.2 の WebSocket と同じ risk）。
 */
function addStream(app: Hono, deps: Deps): void {
  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = deps.hub.subscribe(() => void stream.writeSSE({ data: 'changed' }));
      c.req.raw.signal.addEventListener('abort', unsubscribe);
      while (!c.req.raw.signal.aborted) {
        await stream.writeSSE({ data: 'ping', event: 'ping' });
        await stream.sleep(15_000);
      }
      unsubscribe();
    }),
  );
}

function joinCommand(deps: Deps, partySize: number): Command {
  return {
    type: 'JOIN',
    ticketId: deps.newId(),
    partySize,
    requiredTags: [],
    hasNotificationChannel: true,
  };
}

// ---- 整形 ----

function page(deps: Deps): string {
  return renderPage({
    state: deps.venue.state,
    inputs: deps.store.size,
    uptimeSec: Math.round((deps.now() - deps.startedAt) / 1000),
    version: deps.version,
  });
}

/**
 * 結果を返す。**拒否の文言は `core` の `describe` をそのまま出す。**
 *
 * 利用者向けの文言は `packages/shared` の i18n に置くのが 4 章の決まりだが、
 * その仕組みは Phase 2 で作る。ここで作ると、二重に持つことになる。
 */
function settle(c: Context, deps: Deps, applied: Applied): Response {
  if (!applied.ok) return c.text(`${applied.error.code}: ${applied.error.describe}`, 409);
  if (applied.value.length > 0) deps.hub.publish();
  return c.redirect('/', 303);
}

// ---- 入力の検証 ----

function toText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toPartySize(value: unknown): number | null {
  const text: string | null = toText(value);
  if (text === null) return null;
  const parsed: number = Number(text);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PARTY_SIZE) return null;
  return parsed;
}
