/**
 * サーバの入口。
 *
 * **ここが境界の中心である。** 設定を読み、データベースを開き、施設アクターを
 * 起こし、HTTP を待ち受ける。業務判断は 1 行も書かない（CLAUDE.md 3.1）。
 *
 * **API はまだ `/healthz` だけである。** 利用者の入口は PR 5 から入る。それまでの
 * `/healthz` は、外形監視と置き場のヘルスチェックに加えて、**運用の目（`tick` の
 * 遅れ）** と、**「落として起こし直しても記録が残っているか」を確かめる窓**
 * （`infra/smoke.sh`）を兼ねる。
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import process from 'node:process';
import { open, type Connection } from '../db/client.js';
import { loadVenueState, migrationCount } from '../db/repository.js';
import { openVenueActor, TickFailed, type VenueActor } from '../venue/actor.js';
import { readConfig, type Config } from './config.js';
import { ensureVenue } from './seed.js';

/** 時刻を進める間隔（9.4）。**個別のタイマーは持たない。** */
const TICK_INTERVAL_MS = 10_000;

const config: Config = readConfig();
const connection: Connection = open({
  path: config.dbPath,
  migrationsFolder: config.migrationsFolder,
});

const created: boolean = ensureVenue(connection.db, config, Date.now());
console.log(
  created
    ? `施設 ${config.venueId} を作りました（席 ${config.seedTables}）`
    : `施設 ${config.venueId} を読み込みました`,
);

/** **起動時の復元はここで終わる。** 行から状態を組み立てる（ADR-0013）。 */
const actor: VenueActor = openVenueActor({
  db: connection.db,
  venueId: config.venueId,
  clock: () => Date.now(),
});

/**
 * 10 秒ごとに時刻を進める（9.4）。
 *
 * **止まっていたあいだに時間が飛んでも、来ている期限は次の 1 回で片づく。**
 * 期限は状態に書いてある絶対時刻だからである。
 *
 * **断られたら握り潰さずに記録する。** 時刻が進むことを業務上の理由で拒否する
 * ことはないので、断りは必ず実装の誤りである（CLAUDE.md 6）。
 */
const ticker = setInterval(() => {
  void actor.advance().catch((error: unknown) => {
    if (error instanceof TickFailed) {
      console.error(`tick が拒否されました: ${error.rejection.code} ${error.rejection.describe}`);
      return;
    }
    console.error('tick で予期しない失敗:', error);
  });
}, TICK_INTERVAL_MS);

/**
 * 健康の答え。
 *
 * **秘密は載せない**（CLAUDE.md 7）。座席トークン、端末トークン、通知先は
 * ここに現れない。数と時刻だけで、外から状態の見当がつくようにしてある。
 */
function health(now: number): Record<string, unknown> {
  const state = loadVenueState(connection.db, config.venueId);
  const lastTick: number | null = actor.lastTickAt();
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
    /**
     * **`tick` の遅れ**（CLAUDE.md 8 の監視）。まだ 1 度も進んでいなければ `null`。
     *
     * 10 秒ごとに進めるので、**0〜10 秒のあいだを行き来するのが正常**である。
     * そこを大きく超えたままなら、刻みが止まっているか断られ続けている。
     */
    tickLagMs: lastTick === null ? null : now - lastTick,
    /** 刻みが断られた回数。**0 でないなら実装の誤りが出ている。** */
    tickFailures: actor.tickFailures(),
  };
}

const app = new Hono();

/**
 * **答えられないときは 200 を返さない。** 置き場のヘルスチェックも外形監視も
 * ここを見て生死を決めるので、施設が読めないまま「元気です」と言うと、
 * 壊れたコンテナに人が案内され続ける。
 */
app.get('/healthz', (c) => {
  const report = health(Date.now());
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
  clearInterval(ticker);
  server.close(() => {
    connection.close();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
