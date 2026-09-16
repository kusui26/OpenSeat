#!/usr/bin/env node
/**
 * ドキュメント内の相対リンクが解決するかを確かめる。
 *
 * 計画書・ADR・README は互いを参照し合っているため、章を動かしたときに
 * 気づかずリンクが切れる。外部 URL は対象外（ネットワークに依存させない）。
 *
 *   node scripts/check-doc-links.mjs
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
const LINK = /\]\((?!https?:\/\/|#|mailto:)([^)\s#]+)(?:#[^)]*)?\)/g;

async function collectMarkdown(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      found.push(...(await collectMarkdown(full)));
    } else if (entry.name.endsWith('.md')) {
      found.push(full);
    }
  }
  return found;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function checkFile(filePath) {
  const source = await readFile(filePath, 'utf8');
  const lines = source.split('\n');
  const broken = [];
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(LINK)) {
      const target = decodeURIComponent(match[1]);
      const resolved = resolve(dirname(filePath), target);
      if (!(await exists(resolved))) {
        broken.push({ file: relative(ROOT, filePath), line: index + 1, target });
      }
    }
  }
  return broken;
}

async function main() {
  console.log('ドキュメントの相対リンクの検査');
  const files = await collectMarkdown(ROOT);
  const broken = [];
  for (const file of files) {
    broken.push(...(await checkFile(file)));
  }

  if (broken.length > 0) {
    for (const item of broken) {
      console.error(`  NG  ${item.file}:${item.line}  -> ${item.target}`);
    }
    console.error(`\nリンク切れ ${broken.length} 件。`);
    process.exit(1);
  }
  console.log(`  OK  ${files.length} ファイル、リンク切れなし。`);
}

await main();
