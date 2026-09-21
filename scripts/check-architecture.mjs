#!/usr/bin/env node
/**
 * アーキテクチャ境界の検査。
 *
 * CLAUDE.md 3.3 が宣言している境界を、宣言のままにせず CI で落とすための検査。
 * 依存を持たない素の Node スクリプトとして書いてあるので、`pnpm install` の前でも動く。
 *
 *   node scripts/check-architecture.mjs
 *
 * 違反があれば 1 で終了する。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();

/** `packages/core` で使ってはならない記述。時刻・乱数・環境・I/O を持ち込ませない。 */
const FORBIDDEN_IN_CORE = [
  { pattern: /\bDate\.now\s*\(/, reason: '時刻は引数で受け取る（ADR-0004）' },
  { pattern: /\bnew\s+Date\s*\(/, reason: '時刻は引数で受け取る（ADR-0004）' },
  { pattern: /\bMath\.random\s*\(/, reason: '乱数は境界側で生成して渡す' },
  { pattern: /\bprocess\s*\./, reason: '環境変数・プロセス情報に依存しない' },
  { pattern: /\brequire\s*\(/, reason: 'CommonJS の読み込みを使わない' },
  { pattern: /from\s+['"]node:/, reason: 'Node の組み込みモジュールに依存しない' },
  { pattern: /\bfetch\s*\(/, reason: 'I/O を行わない' },
  { pattern: /\bconsole\s*\./, reason: '出力は境界側の責務' },
];

/**
 * `packages/core/sim` で使ってはならない記述。
 *
 * シミュレータは乱数と時刻を持ってよい層だが、**再現できることが命**である。
 * 種から導かない乱数や実時刻が混ざると、同じシードで同じ結果にならなくなり、
 * 方針の比較（全体プラン 8.2）が成り立たない。
 */
const FORBIDDEN_IN_SIM = [
  { pattern: /\bMath\.random\s*\(/, reason: '種から導く乱数だけを使う（sim/rng.ts）' },
  { pattern: /\bDate\.now\s*\(/, reason: '仮想時刻だけを使う' },
  { pattern: /\bnew\s+Date\s*\(/, reason: '仮想時刻だけを使う' },
];

/**
 * シミュレータの本体で使ってはならない記述。**入口（`sim/main.ts`）だけが例外**。
 *
 * 引数を読む・ファイルに書く・画面に出すのは境界 1 つに閉じる（CLAUDE.md 4 章）。
 * ここを開けると、指標の計算の途中に読み書きが混ざり、テストできなくなる。
 */
const FORBIDDEN_OUTSIDE_SIM_ENTRY = [
  { pattern: /\bprocess\s*\./, reason: '引数と環境を読むのは sim/main.ts だけ' },
  { pattern: /\bconsole\s*\./, reason: '画面に出すのは sim/main.ts だけ' },
  { pattern: /\bfetch\s*\(/, reason: 'シミュレータは I/O を行わない' },
  { pattern: /from\s+['"]node:/, reason: 'Node の組み込みに触るのは sim/main.ts だけ' },
];

/** シミュレータの入口。ここだけが `process` と `node:fs` に触ってよい。 */
const SIM_ENTRY = join('packages', 'core', 'sim', 'main.ts');

/** ルート層から直接触ってはならないもの。ドメインへの委譲を迂回させない。 */
const FORBIDDEN_IN_ROUTES = [
  { pattern: /from\s+['"][^'"]*\/db\//, reason: 'ルートから永続化層を直接呼ばない（CLAUDE.md 3.1）' },
  { pattern: /from\s+['"]drizzle-orm/, reason: 'ルートから ORM を直接呼ばない（CLAUDE.md 3.1）' },
  { pattern: /from\s+['"][^'"]*schema(\.js)?['"]/, reason: 'ルートからスキーマを直接参照しない' },
];

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-sim', 'build', 'coverage', '.git']);

/** ディレクトリ配下の TypeScript ファイルを集める。存在しなければ空配列。 */
async function collectSources(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      found.push(...(await collectSources(full)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** 行コメントと複数行コメントを除いた本文を返す。説明文の中の語で誤検知しないため。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function scan(filePath, source, rules) {
  const body = stripComments(source);
  const lines = body.split('\n');
  const found = [];
  for (const rule of rules) {
    lines.forEach((line, index) => {
      if (rule.pattern.test(line)) {
        found.push({
          file: relative(ROOT, filePath),
          line: index + 1,
          reason: rule.reason,
          text: line.trim(),
        });
      }
    });
  }
  return found;
}

/** マニフェストを読む。存在しなければ null。 */
async function readManifest(path) {
  try {
    await stat(path);
  } catch {
    return null;
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

function dependencyProblem(field, names) {
  return {
    file: 'packages/core/package.json',
    line: 0,
    reason: `packages/core は依存ゼロを保つ（ADR-0004）。${field} に ${names.join(', ')} がある`,
    text: field,
  };
}

/** `packages/core` が依存ゼロであることを確かめる。 */
async function checkCoreHasNoDependencies() {
  const manifest = await readManifest(join(ROOT, 'packages', 'core', 'package.json'));
  if (manifest === null) return [];
  const fields = ['dependencies', 'peerDependencies', 'optionalDependencies'];
  return fields
    .map((field) => ({ field, names: Object.keys(manifest[field] ?? {}) }))
    .filter((entry) => entry.names.length > 0)
    .map((entry) => dependencyProblem(entry.field, entry.names));
}

/** テストファイルは対象外にする。テストでは時刻の偽装などが必要になるため。 */
function isTest(filePath) {
  return filePath.endsWith('.test.ts') || filePath.includes(`${sep}__tests__${sep}`);
}

async function checkCorePurity() {
  const files = await collectSources(join(ROOT, 'packages', 'core', 'src'));
  const problems = [];
  for (const file of files.filter((candidate) => !isTest(candidate))) {
    problems.push(...scan(file, await readFile(file, 'utf8'), FORBIDDEN_IN_CORE));
  }
  return problems;
}

/** シミュレータが再現可能であることを確かめる。 */
async function checkSimIsReproducible() {
  const files = await collectSources(join(ROOT, 'packages', 'core', 'sim'));
  const problems = [];
  for (const file of files) {
    problems.push(...scan(file, await readFile(file, 'utf8'), FORBIDDEN_IN_SIM));
  }
  return problems;
}

/** シミュレータの読み書きが、入口 1 つに閉じていることを確かめる。 */
async function checkSimIoStaysAtEntry() {
  const files = await collectSources(join(ROOT, 'packages', 'core', 'sim'));
  const problems = [];
  for (const file of files) {
    if (isTest(file) || relative(ROOT, file) === SIM_ENTRY) continue;
    problems.push(...scan(file, await readFile(file, 'utf8'), FORBIDDEN_OUTSIDE_SIM_ENTRY));
  }
  return problems;
}

async function checkRouteBoundaries() {
  const files = await collectSources(join(ROOT, 'apps', 'server', 'src', 'routes'));
  const problems = [];
  for (const file of files) {
    problems.push(...scan(file, await readFile(file, 'utf8'), FORBIDDEN_IN_ROUTES));
  }
  return problems;
}

function report(title, problems) {
  if (problems.length === 0) {
    console.log(`  OK  ${title}`);
    return 0;
  }
  console.log(`  NG  ${title}`);
  for (const problem of problems) {
    const where = problem.line > 0 ? `${problem.file}:${problem.line}` : problem.file;
    console.log(`        ${where}  ${problem.reason}`);
    if (problem.line > 0) console.log(`        > ${problem.text}`);
  }
  return problems.length;
}

async function main() {
  console.log('アーキテクチャ境界の検査');
  let failures = 0;
  failures += report('packages/core が依存ゼロである', await checkCoreHasNoDependencies());
  failures += report('packages/core が純粋である（時刻・乱数・環境・I/O を持たない）', await checkCorePurity());
  failures += report('packages/core/sim が再現可能である（種から導く乱数と仮想時刻だけ）', await checkSimIsReproducible());
  failures += report('packages/core/sim の読み書きが sim/main.ts に閉じている', await checkSimIoStaysAtEntry());
  failures += report('ルート層が永続化層を直接呼んでいない', await checkRouteBoundaries());

  if (failures > 0) {
    console.error(`\n違反 ${failures} 件。CLAUDE.md 3.3 を参照してください。`);
    process.exit(1);
  }
  console.log('\n違反なし。');
}

await main();
