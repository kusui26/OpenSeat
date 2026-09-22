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

/**
 * `packages/shared` で使ってはならない記述。
 *
 * **ここは画面（`apps/web`）もサーバも読む層である。** ブラウザに Node の組み込みは
 * 無いので、1 つでも混ざると画面が動かない。契約と文言しか置かない層なので、
 * そもそも要らないはずである。
 */
const FORBIDDEN_IN_SHARED = [
  { pattern: /from\s+['"]node:/, reason: 'shared は画面からも読む。Node の組み込みに依存しない' },
  { pattern: /\bprocess\s*\./, reason: 'shared は環境変数を読まない（境界側の責務）' },
  { pattern: /\bfetch\s*\(/, reason: 'shared は I/O を行わない。契約と文言だけを置く' },
  { pattern: /\bconsole\s*\./, reason: '出力は境界側の責務' },
];

/** `packages/shared` が持ってよい依存。**増やすときは理由を PR に書くこと。** */
const ALLOWED_SHARED_DEPENDENCIES = ['zod', '@openseat/core'];

/**
 * ルート層から直接触ってはならないもの。ドメインへの委譲を迂回させない。
 *
 * **権限の判定も含む**（CLAUDE.md 3.2(4)）。誰が何を出せるかは `core` の表が決め、
 * `dispatch` が適用の前に評価する。ハンドラに `if (role === 'staff')` を書くと、
 * **ハンドラを書き換えるたびに権限が変わりうる**ことになる。
 */
const FORBIDDEN_IN_ROUTES = [
  { pattern: /from\s+['"][^'"]*\/db\//, reason: 'ルートから永続化層を直接呼ばない（CLAUDE.md 3.1）' },
  { pattern: /from\s+['"]drizzle-orm/, reason: 'ルートから ORM を直接呼ばない（CLAUDE.md 3.1）' },
  { pattern: /from\s+['"][^'"]*schema(\.js)?['"]/, reason: 'ルートからスキーマを直接参照しない' },
  { pattern: /\bPERMISSIONS\b/, reason: 'ルートで権限表を読まない。dispatch が評価する（CLAUDE.md 3.2(4)）' },
  { pattern: /\b(role|by)\s*===/, reason: 'ルートで役割を判定しない（CLAUDE.md 3.2(4)）' },
  { pattern: /\bisPermitted\b/, reason: 'ルートで権限を判定しない。dispatch が評価する' },
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

/**
 * ルート層の置き場の候補。
 *
 * **両方を見る。** CLAUDE.md 3.1 は `apps/server/routes` と書き、入口は
 * `apps/server/src` にある。どちらに置かれても検査が素通りしないようにしておく。
 * 片方だけを見ていると、**ファイルが 1 つも無いまま「違反なし」と言う**検査になる。
 */
const ROUTE_DIRECTORIES = [
  join('apps', 'server', 'routes'),
  join('apps', 'server', 'src', 'routes'),
];

/** `packages/shared` が画面でも動くことを確かめる。 */
async function checkSharedRunsAnywhere() {
  const files = await collectSources(join(ROOT, 'packages', 'shared', 'src'));
  const problems = [];
  for (const file of files.filter((candidate) => !isTest(candidate))) {
    problems.push(...scan(file, await readFile(file, 'utf8'), FORBIDDEN_IN_SHARED));
  }
  return problems;
}

/** `packages/shared` の依存が、許したものだけであることを確かめる。 */
async function checkSharedDependencies() {
  const manifest = await readManifest(join(ROOT, 'packages', 'shared', 'package.json'));
  if (manifest === null) return [];
  const names = Object.keys(manifest.dependencies ?? {});
  const extra = names.filter((name) => !ALLOWED_SHARED_DEPENDENCIES.includes(name));
  if (extra.length === 0) return [];
  return [
    {
      file: 'packages/shared/package.json',
      line: 0,
      reason: `shared の依存は ${ALLOWED_SHARED_DEPENDENCIES.join(' と ')} だけにする。${extra.join(', ')} がある`,
      text: 'dependencies',
    },
  ];
}

async function checkRouteBoundaries() {
  const problems = [];
  for (const directory of ROUTE_DIRECTORIES) {
    for (const file of await collectSources(join(ROOT, directory))) {
      problems.push(...scan(file, await readFile(file, 'utf8'), FORBIDDEN_IN_ROUTES));
    }
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
  failures += report('packages/shared が画面でも動く（Node の組み込みに触らない）', await checkSharedRunsAnywhere());
  failures += report('packages/shared の依存が最小である', await checkSharedDependencies());
  failures += report(
    'ルート層が永続化層を直接呼ばず、権限も判定していない',
    await checkRouteBoundaries(),
  );

  if (failures > 0) {
    console.error(`\n違反 ${failures} 件。CLAUDE.md 3.3 を参照してください。`);
    process.exit(1);
  }
  console.log('\n違反なし。');
}

await main();
