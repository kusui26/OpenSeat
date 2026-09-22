#!/usr/bin/env node
/**
 * 相対リンクが解決するかを確かめる。
 *
 * 計画書・ADR・README は互いを参照し合っているため、章を動かしたときに
 * 気づかずリンクが切れる。外部 URL は対象外（ネットワークに依存させない）。
 *
 * **コードの中の説明も見る。** この計画では、判断の理由を実装のそばに書き、
 * 計画書と ADR へリンクを張っている。**むしろそちらのほうが数が多い**ので、
 * Markdown だけを見ていると、切れたまま何年も残る。
 *
 *   node scripts/check-doc-links.mjs
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
const LINK = /\]\((?!https?:\/\/|#|mailto:)([^)\s#]+)(?:#[^)]*)?\)/g;

/** 見るファイル。**説明はコードの中にもある。** */
function isChecked(name) {
  return name.endsWith('.md') || isCode(name);
}

function isCode(name) {
  return name.endsWith('.ts') || name.endsWith('.tsx');
}

const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/**
 * コードからは、説明だけを取り出す。
 *
 * **本文まで見るとリンクに見えるものがある。** 正規表現の `](?:...)` がその例で、
 * リンクの書き方とまったく同じ形をしている。行番号を保ちたいので、**捨てる
 * ところは空白に置き換える**（消すと行がずれて、報告が読めなくなる）。
 */
function commentsOf(source) {
  const kept = [];
  let last = 0;
  for (const found of source.matchAll(COMMENT)) {
    kept.push(blanked(source.slice(last, found.index)), found[0]);
    last = found.index + found[0].length;
  }
  kept.push(blanked(source.slice(last)));
  return kept.join('');
}

const blanked = (text) => text.replace(/[^\n]/g, ' ');

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      found.push(...(await collectFiles(full)));
    } else if (isChecked(entry.name)) {
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
  const lines = (isCode(filePath) ? commentsOf(source) : source).split('\n');
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
  console.log('相対リンクの検査（ドキュメントとコードの説明）');
  const files = await collectFiles(ROOT);
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
