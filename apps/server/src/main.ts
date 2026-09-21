/**
 * サーバの入口。
 *
 * **ここが境界の中心である。** 設定を読み、データベースを開き、HTTP を待ち受ける。
 * 業務判断は 1 行も書かない（CLAUDE.md 3.1）。
 *
 * **いまあるのは `/healthz` だけである。** API は PR 2（契約）と PR 3（施設アクター）
 * で入る。それまでの `/healthz` は、外形監視と置き場のヘルスチェックに加えて、
 * **「落として起こし直しても記録が残っているか」を確かめる窓**でもある
 * （`infra/smoke.sh`）。
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import process from 'node:process';
import { open, type Connection } from '../db/client.js';
import { loadVenueState, migrationCount } from '../db/repository.js';
import { readConfig, type Config } from './config.js';
import { ensureVenue } from './seed.js';

const config: Config = readConfig();
const connection: Connection = open({
  path: config.dbPath,
  migrationsFolder: config.migrationsFolder,
});

const created: boolean = ensureVenue(connection.db, config, Date.now());
console.log(
  created ? `施設 ${config.venueId} を作りました（席 ${config.seedTables}）` : `施設 ${config.venueId} を読み込みました`,
);

/**
 * 健康の答え。
 *
 * **秘密は載せない**（CLAUDE.md 7）。座席トークン、端末トークン、通知先は
 * ここに現れない。数と時刻だけで、外から状態の見当がつくようにしてある。
 */
function health(): Record<string, unknown> {
  const state = loadVenueState(connection.db, config.venueId);
  return {
    ok: state !== null,
    revision: config.revision,
    migrations: migrationCount(connection.db),
    venue: config.venueId,
    tables: state?.tables.length ?? 0,
    tickets: state?.tickets.length ?? 0,
    operating: state?.operating ?? false,
    /** 状態が知っている最後の時刻。再起動をまたいで残る（9.4）。 */
    clockAt: state?.clockAt ?? null,
  };
}

const app = new Hono();

/**
 * **答えられないときは 200 を返さない。** 置き場のヘルスチェックも外形監視も
 * ここを見て生死を決めるので、施設が読めないまま「元気です」と言うと、
 * 壊れたコンテナに人が案内され続ける。
 */
app.get('/healthz', (c) => {
  const report = health();
  return c.json(report, report['ok'] === true ? 200 : 503);
});

const server = serve({ fetch: app.fetch, port: config.port });
console.log(`OpenSeat を ${String(config.port)} で待ち受けます（記録: ${config.dbPath}）`);

/**
 * 終了の合図で、開いているものを閉じる。
 *
 * **再デプロイのときに記録を閉じられないと、WAL が残ったまま次が起きる。**
 * `Dockerfile` が `node` を PID 1 にしてあるのは、この合図を届けるためである。
 */
function shutdown(): void {
  server.close(() => {
    connection.close();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
