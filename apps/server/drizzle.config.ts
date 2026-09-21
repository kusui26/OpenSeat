/**
 * `drizzle-kit` の設定。**マイグレーションを生成するためだけに使う。**
 *
 * 出典は `db/schema.ts` である（CLAUDE.md 3.2(1)）。ここを変えても整合性は
 * 変わらない。列や制約を足したら `pnpm db:generate` を走らせ、生成された SQL を
 * そのままコミットする。**手で書き足さないこと。**
 *
 * 適用は実行時に `db/client.ts` が行う（`drizzle-kit migrate` は使わない）。
 * 施設や地域の IT 事業者が引き取ったあと、コンテナを起こすだけでスキーマが
 * 追いつく形にしておきたいため（9.13）。
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './db/schema.ts',
  out: './db/migrations',
});
