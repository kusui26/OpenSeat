/**
 * SQLite への接続と、マイグレーションの適用。
 *
 * **ここは境界である。** ファイルを開き、`PRAGMA` を投げ、マイグレーションを走らせる。
 * 業務判断は 1 行も書かない（CLAUDE.md 3.1）。
 *
 * ドライバに `better-sqlite3` を選んだ理由は
 * [ADR-0012](../../../docs/adr/0012-sqlite-driver.md) にある。
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** 接続と、その後ろにいる生のハンドル。閉じるために両方を持つ。 */
export interface Connection {
  readonly db: Db;
  readonly close: () => void;
}

/**
 * 開いたときに必ず投げる設定。
 *
 * | 設定 | なぜ |
 * |---|---|
 * | `journal_mode = WAL` | **Litestream が WAL を前提にする**（9.13 のバックアップ）。読みと書きが互いを待たなくなる利点もある |
 * | `synchronous = NORMAL` | WAL では既定の `FULL` まで要らない。電源断で直近の書き込みを失うことはあるが、ファイルは壊れない。Litestream の推奨もこれ |
 * | `foreign_keys = ON` | **SQLite は既定で外部キーを見ない。** 明示しないと、宣言した参照がただの飾りになる |
 * | `busy_timeout` | 施設ごとに 1 つのアクターが順に書くので競合は起きないはずだが、バックアップと重なることはある。黙って諦めさせない |
 */
const PRAGMAS: readonly string[] = [
  'journal_mode = WAL',
  'synchronous = NORMAL',
  'foreign_keys = ON',
  'busy_timeout = 5000',
];

/** マイグレーションの置き場（`drizzle-kit generate` の出力）。 */
export const MIGRATIONS_DIR = 'db/migrations';

export interface OpenOptions {
  /** SQLite のファイル。`:memory:` も取るが、**テスト以外では使わない**。 */
  readonly path: string;
  /** マイグレーションの置き場。実行時の作業ディレクトリからの相対で渡す。 */
  readonly migrationsFolder?: string;
}

/**
 * データベースを開き、マイグレーションを適用して返す。
 *
 * **起動のたびに適用する。** 施設や地域の IT 事業者が引き取ったあと、
 * 「コンテナを新しくしたらスキーマが古いままだった」を起こさないため（9.13）。
 */
export function open(options: OpenOptions): Connection {
  // ボリュームを付けたばかりの `/data` は空である。作ってから開く。
  if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });

  const sqlite = new Database(options.path);
  for (const pragma of PRAGMAS) sqlite.pragma(pragma);

  const db: Db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: options.migrationsFolder ?? MIGRATIONS_DIR });

  return {
    db,
    close: () => {
      sqlite.close();
    },
  };
}
