/**
 * 起動（Phase 2 の 1 日スパイク。開発プラン 9.13）。
 *
 * **このファイルだけが `process` と時刻と乱数に触る。** 設定を読み、記録を開き、
 * 施設を取り戻し、10 秒ごとに `tick` を回し、HTTP を待ち受ける。業務の判断は
 * すべて `packages/core` にある（CLAUDE.md 3 章）。
 *
 * ## 確かめたいこと（9.13）
 *
 * 1. `packages/core` を Node のサーバから素直に呼べるか（ワークスペース依存 ＋ ESM）
 * 2. `node:sqlite` が依存を足さずに使えるか
 * 3. 単一コンテナが Docker で組み上がり、ボリュームに置いた SQLite が再デプロイを
 *    またいで残るか
 * 4. Railway に置いて、独自ドメインで開けるか
 *
 * **ここで詰まるなら見積もりが甘いので、9.3 の技術選定を見直す。**
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { serve } from '@hono/node-server';
import type { Timestamp, VenueState } from '@openseat/core';
import { createTable, createVenueState, DEFAULT_POLICY, seconds } from '@openseat/core';
import { Hub } from './hub.js';
import { createApp } from './routes.js';
import { Store } from './store.js';
import { Venue } from './venue.js';

/** `tick` を呼ぶ間隔。9.4 が定める 10 秒。 */
const TICK_INTERVAL = seconds(10);

/** 席は 2 卓だけ。**割当が実際に起きる最小の数**である（1 卓だと選ぶ余地が無い）。 */
const TABLES = [
  { id: 'a1', label: 'A-1', capacity: 2 },
  { id: 'b1', label: 'B-1', capacity: 4 },
] as const;

interface Config {
  readonly port: number;
  readonly dbPath: string;
  readonly venueId: string;
  readonly version: string;
}

/**
 * 設定を環境変数から読む。
 *
 * `DB_PATH` の既定を `/data` の下にしてあるのは、**Railway でボリュームを
 * そこへ載せる**ため（9.13）。手元では `./data` を使う。
 */
function readConfig(): Config {
  return {
    port: Number(process.env['PORT'] ?? '8080'),
    dbPath: process.env['DB_PATH'] ?? './data/spike.db',
    venueId: process.env['VENUE_ID'] ?? 'spike',
    version: process.env['GIT_SHA'] ?? 'dev',
  };
}

function emptyVenue(venueId: string, now: Timestamp): VenueState {
  return createVenueState({
    venueId,
    policy: DEFAULT_POLICY,
    tables: TABLES.map((spec) => createTable({ ...spec, now })),
  });
}

/**
 * 運用を始める。**すでに始まっていれば何もしない。**
 *
 * 記録から取り戻した施設は運用中のままなので、2 度目以降の起動では通らない。
 * 曜日と時間帯（`managed_schedule`）の評価は境界の責務だが（9.4）、スパイクでは
 * 手動で開けたままにする。
 */
function ensureOpen(venue: Venue, now: Timestamp): void {
  if (venue.state.operating) return;
  const opened = venue.dispatch({ type: 'OPEN', closesAt: null, by: 'staff' }, now);
  if (!opened.ok) throw new Error(`運用を開始できない: ${opened.error.describe}`);
}

function main(): void {
  const config: Config = readConfig();
  const now = (): Timestamp => Date.now();

  mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = new Store(config.dbPath);
  const venue: Venue = Venue.restore(store, emptyVenue(config.venueId, now()));
  ensureOpen(venue, now());

  const hub = new Hub();
  const app = createApp({ venue, store, hub, now, newId: randomUUID, startedAt: now(), version: config.version });
  const server = serve({ fetch: app.fetch, port: config.port });
  console.log(`[spike] ${config.venueId} を ${String(config.port)} で待ち受け（記録 ${String(store.size)} 件、版 ${config.version}）`);

  const timer = setInterval(() => {
    if (venue.advance(now()).length > 0) hub.publish();
  }, TICK_INTERVAL);

  installShutdown(() => {
    clearInterval(timer);
    server.close();
    store.close();
  });
}

/**
 * 終わらせ方。**Railway は再デプロイのときに `SIGTERM` を送る。**
 *
 * ここで記録を閉じておかないと、書きかけが残る可能性がある。停止に何秒かかるかは
 * 9.13 の「再デプロイ時の短い停止」を測るときに見る値でもある。
 */
function installShutdown(stop: () => void): void {
  let stopping = false;
  const handle = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[spike] ${signal} を受けたので終わります`);
    stop();
  };
  process.on('SIGTERM', () => {
    handle('SIGTERM');
  });
  process.on('SIGINT', () => {
    handle('SIGINT');
  });
}

main();
