#!/usr/bin/env node
/**
 * OpenAPI の文書を書き出す（開発プラン 9.7）。
 *
 * **手で書いた文書は必ず古くなる。** 出典は `packages/shared` の一覧
 * （`src/api/catalog.ts`）で、ここはそれを JSON にするだけである。
 *
 *   pnpm openapi
 *
 * 書き出した `docs/openapi.json` はコミットする。**外部連携と、将来のセンサー
 * 入力**のために、リポジトリを見ただけで話せる形が要るためである（9.7）。
 * 中身が最新かどうかは `openapi.test.ts` が見ている。
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const OUT = join(process.cwd(), 'docs', 'openapi.json');

const shared = await import('../packages/shared/dist/index.js').catch(() => null);
if (shared === null) {
  console.error('packages/shared が組み立てられていません。先に pnpm build を走らせてください。');
  process.exit(1);
}

// 版はつけない。**API の版はパッケージの版とは別物**で、外部連携が見るのは
// こちらである。付け始めるのは、外向けに公開してからでよい。
const document = shared.openApiDocument();
await writeFile(OUT, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`${OUT} を書き出しました（入口 ${Object.keys(document.paths).length} 本）。`);
