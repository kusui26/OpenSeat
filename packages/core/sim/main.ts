/**
 * CLI の境界（全体プラン 8.4）。
 *
 *     pnpm sim --scenario weekend-peak --runs 200 --seed 1 --out result.csv
 *
 * **このファイルだけが `process` と `node:fs` に触る。** 引数を読むのも、
 * 走らせるのも、文字列を組み立てるのも `cli.ts` と `report.ts` の純粋な関数で、
 * ここがするのは「受け取って、渡して、書く」だけである（CLAUDE.md 4 章の
 * 「副作用は境界に集める」）。テストが要らないくらい薄く保つこと。
 *
 * **黙って成功しない。** 実装の誤りを示す拒否が 1 件でもあれば、あるいは席の
 * 区間に覆い漏れがあれば、CSV を書かずに終了コード 1 で終わる。壊れた数字を
 * ファイルに残すと、あとで「そういう結果だった」と読まれてしまう。
 */

import { writeFileSync } from 'node:fs';
import process from 'node:process';
import type { Batch } from './cli.js';
import { parseArgs, runBatch, summaryOf, toCsv, USAGE } from './cli.js';
import { toHtml } from './report.js';

function main(argv: readonly string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const options = parseArgs(argv);
  if (!options.ok) {
    console.error(`${options.error}\n\n${USAGE}`);
    return 1;
  }

  const batch: Batch = runBatch(options.value);
  console.log(summaryOf(batch));
  const problems: readonly string[] = [...batch.defects, ...batch.gaps];
  if (problems.length > 0) return complain(problems);

  write(options.value.out, () => toCsv(batch), 'CSV');
  write(options.value.html, () => toHtml(batch), 'HTML');
  return 0;
}

/** 書き出し先が指定されていれば書く。 */
function write(path: string | null, build: () => string, what: string): void {
  if (path === null) return;
  writeFileSync(path, build(), 'utf8');
  console.log(`\n${what} を書き出しました: ${path}`);
}

function complain(problems: readonly string[]): number {
  console.error(`\n**${String(problems.length)} 件の問題があったので、書き出しを止めました。**`);
  for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
  if (problems.length > 20) console.error(`  ほか ${String(problems.length - 20)} 件`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
