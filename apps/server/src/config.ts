/**
 * 環境から読む設定。
 *
 * **環境変数を読むのはここだけにする**（CLAUDE.md 4 章「副作用は境界に集める」）。
 * ほかの場所は、この型を受け取る。
 *
 * **秘密はここに現れない。** 鍵やトークンが要るのは PR 12（認証）と
 * PR 16（通知）からで、そのときも `.env` で扱い、名前だけを `.env.example` に置く。
 */

import process from 'node:process';

export interface Config {
  readonly port: number;
  /** SQLite のファイル。コンテナではボリュームの中を指す（9.13）。 */
  readonly dbPath: string;
  /** マイグレーションの置き場。実行時の作業ディレクトリからの相対。 */
  readonly migrationsFolder: string;
  readonly venueId: string;
  readonly venueName: string;
  /**
   * まだその施設が無いときに作る席の数。
   *
   * **足場である。** 席の一覧編集は PR 13 で入る。それまでは、起動しても
   * 席が 1 つも無い状態になってしまい、通し確認（`infra/smoke.sh`）が何も見られない。
   */
  readonly seedTables: number;
  /**
   * 作った施設を、そのまま運用中にするか。
   *
   * **足場である。** 運用の開始はスタッフの操作か、曜日と時間帯の設定で決まる
   * （7.14）。その入口は PR 14 で入るので、それまで手元とコンテナの通し確認が
   * 何も試せない。**すでにある施設には効かない。**
   */
  readonly seedOpen: boolean;
  /** 画面に出す版。Railway が `RAILWAY_GIT_COMMIT_SHA` を入れる。 */
  readonly revision: string;
}

const DEFAULTS = {
  port: 8080,
  dbPath: './data/openseat.db',
  migrationsFolder: 'db/migrations',
  venueId: 'demo',
  venueName: 'OpenSeat',
  seedTables: 0,
  seedOpen: false,
  revision: 'dev',
} as const satisfies Config;

/** 数として読む。読めなければ既定に倒す。**起動を止めない。** */
function number(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: number(env['PORT'], DEFAULTS.port),
    dbPath: env['DB_PATH'] ?? DEFAULTS.dbPath,
    migrationsFolder: env['MIGRATIONS_DIR'] ?? DEFAULTS.migrationsFolder,
    venueId: env['VENUE_ID'] ?? DEFAULTS.venueId,
    venueName: env['VENUE_NAME'] ?? DEFAULTS.venueName,
    seedTables: number(env['SEED_TABLES'], DEFAULTS.seedTables),
    seedOpen: env['SEED_OPEN'] === 'true',
    revision: env['GIT_SHA'] ?? DEFAULTS.revision,
  };
}
