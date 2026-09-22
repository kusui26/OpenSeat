/**
 * E2E のためのサーバ。**本番の入口（`apps/server/src/main.ts`）とは別物である。**
 *
 * ## なぜ別に立てるのか
 *
 * 開発プラン 9.12 は「時計は偽装して期限切れを再現する」と求めている。期限を
 * 判断するのはサーバなので、**外から時計を動かせなければならない。**
 *
 * **その口を本番に開けない。** 時刻を動かせる入口は、順番を飛ばす・席を取り上げる
 * といったことを外から起こせる、という意味である（CLAUDE.md 7 章）。だから
 * ここに閉じる —— **このファイルはコンテナに入らない。**
 *
 * ## それでも「通し」である理由
 *
 * 組み立てているのは**本物の `buildApp`**（PR 6 で切り出したもの）で、本物の
 * SQLite に本物のマイグレーションを当て、**本物の画面の組み上がり**を配る。
 * 違うのは 3 つだけである。
 *
 * | | 本番 | ここ |
 * |---|---|---|
 * | 時計 | `Date.now()` | `Date.now() + ずらし`。外から進められる |
 * | 刻み | 10 秒ごと | 200 ミリ秒ごと（待たされないため） |
 * | 追加の口 | 無い | `/__test/*`（時計と、席の QR） |
 *
 * 本番の入口そのもの（設定の読み取り・停止の合図・再起動で記録が残ること）は、
 * コンテナの通し確認（`infra/smoke.sh`）が見ている。
 */

import { member, minutes } from '@openseat/core';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { open, type Connection } from '@openseat/server/dist/db/client.js';
import { openHub, type Hub } from '@openseat/server/dist/stream/hub.js';
import { buildApp } from '@openseat/server/dist/src/app.js';
import { ensureVenue } from '@openseat/server/dist/src/seed.js';
import { webApp } from '@openseat/server/dist/src/web.js';
import { openRegistry, type Registry } from '@openseat/server/dist/venue/registry.js';
import { controlRoutes, type Clock } from './control.ts';

/** 待たされないための刻み。**本番は 10 秒**（9.4）。 */
const TICK_MS = 200;

const ROOT: string = resolve(import.meta.dirname, '..', '..');
const PORT = Number(process.env['E2E_PORT'] ?? '8130');

/** 施設の名前。**筋書きから読めるように、本番の既定とは変えてある。** */
const VENUE = 'e2e';

/**
 * 進められる時計。
 *
 * **実時刻に、ずらしを足したものである。** 止めない ——
 * 画面のカウントダウンが動くところまで含めて確かめたいからである。
 */
function movableClock(): Clock {
  let offsetMs = 0;
  return {
    now: () => Date.now() + offsetMs,
    advance: (ms) => {
      offsetMs += ms;
    },
  };
}

const store: string = mkdtempSync(join(tmpdir(), 'openseat-e2e-'));
const connection: Connection = open({
  path: join(store, 'openseat.db'),
  // **マイグレーションは組み上がりに入らない**（`tsc` は `.sql` を写さない）。
  // コンテナでは `pnpm deploy` が写す。ここでは元の置き場を直に指す。
  migrationsFolder: join(ROOT, 'apps', 'server', 'db', 'migrations'),
});

const clock: Clock = movableClock();

const hub: Hub = openHub({
  onTrouble: (error: unknown) => {
    console.error('配信の組み立てで失敗:', error);
  },
});

const registry: Registry = openRegistry({
  db: connection.db,
  clock: clock.now,
  onOpen: (opened) => {
    opened.onCommitted(() => {
      hub.wake(opened.venueId);
    });
  },
});

ensureVenue(
  connection.db,
  {
    port: PORT,
    dbPath: '',
    migrationsFolder: '',
    webDir: '',
    venueId: VENUE,
    venueName: 'E2E フードコート',
    // **本番と同じ作り方で席を作る**（`seed.ts`）。QR のトークンも本物と同じく
    // 推測不能な乱数なので、筋書きは `/__test/tables` から引く。
    seedTables: 4,
    // **ここでは開けない。** 足場の営業時間は 12 時間で、筋書きが時計を進めて
    // いくと（期限切れの再現）いつか閉店に届く。下で、届かない長さにして開ける。
    seedOpen: false,
    revision: 'e2e',
  },
  clock.now(),
);

const venue = registry.find(VENUE);
if (venue === null) throw new Error('施設を起こせません');

/**
 * 運用を始める（7.14）。
 *
 * **閉店を、筋書きが届かない先に置く。** 期限切れを再現するたびに時計が進むので、
 * 短く切ると、筋書きが増えたあるとき突然「本日の受付は終了しました」になる。
 */
await venue.send({
  actor: member('staff', 'e2e'),
  command: { type: 'OPEN', closesAt: clock.now() + minutes(30 * 24 * 60), by: 'staff' },
  key: 'e2e-open-000000',
  identity: null,
});

/** 刻みを 1 回。**断りは実装の誤りなので、握り潰さずに出す。** */
async function tick(): Promise<void> {
  for (const venue of registry.all()) {
    await venue.advance().catch((error: unknown) => {
      console.error('tick が失敗:', error);
    });
  }
}

const ticker = setInterval(() => void tick(), TICK_MS);

const app = new Hono();
// **テスト専用の口を先に載せる。** 画面はどの道も 1 枚目に落とすので（ADR-0016）、
// あとに置くと画面が返ってしまう。
app.route('/', controlRoutes({ clock, tick, db: connection.db, venueId: VENUE }));
app.route(
  '/',
  buildApp({
    db: connection.db,
    registry,
    clock: clock.now,
    web: webApp(join(ROOT, 'apps', 'web', 'dist')),
    hub,
    health: () => ({ ok: true, venue: VENUE, connections: hub.watching() }),
  }),
);

const server = serve({ fetch: app.fetch, port: PORT });
console.log(`E2E のサーバを ${String(PORT)} で待ち受けます（記録: ${store}）`);

function shutdown(): void {
  clearInterval(ticker);
  server.close(() => {
    connection.close();
    rmSync(store, { recursive: true, force: true });
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
