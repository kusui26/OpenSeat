// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * CLAUDE.md の規約のうち、機械的に判定できるものを lint で落とす。
 * 判定できないもの（層の責務、説明可能性）はレビューと ADR で担保する。
 *
 * 型情報を使う検査は TypeScript のファイルだけに適用する。スクリプトと設定ファイルは
 * 境界側なので、Node の機能を使ってよく、型情報も使わない。
 */

const NODE_GLOBALS = {
  console: 'readonly',
  process: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  structuredClone: 'readonly',
  fetch: 'readonly',
};

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/dist-sim/**', '**/coverage/**', '**/node_modules/**', '**/*.tsbuildinfo'],
  },

  // ---- TypeScript（型情報つき） ----
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // ルート直下の設定ファイルはどの tsconfig にも属さないため、
          // 型情報なしの既定プロジェクトで解析する。
          allowDefaultProject: ['*.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 型を厳格に（CLAUDE.md 4 章）
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // 不変・関数型（CLAUDE.md 4 章）
      'prefer-const': 'error',
      'no-var': 'error',
      'no-param-reassign': ['error', { props: true }],

      // 小さく保つ
      'max-lines-per-function': ['warn', { max: 20, skipBlankLines: true, skipComments: true }],
      complexity: ['warn', 10],
    },
  },

  // ---- packages/core は純粋関数のみ ----
  // 時刻・乱数・環境・I/O を持ち込ませない。編集中に気づけるよう lint でも落とす。
  // 網羅的な検査は scripts/check-architecture.mjs にある（ADR-0004）。
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'core は環境に依存しない（ADR-0004）' },
        { name: 'fetch', message: 'core は I/O を行わない（ADR-0004）' },
        { name: 'console', message: '出力は境界側の責務（ADR-0004）' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: '時刻は引数で受け取る（ADR-0004）' },
        { object: 'Math', property: 'random', message: '乱数は境界側で生成して渡す（ADR-0004）' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: '時刻は引数で受け取る（ADR-0004）',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'core は Node の組み込みに依存しない（ADR-0004）' },
          ],
        },
      ],
    },
  },

  // ---- packages/core/sim はシミュレータ ----
  // 乱数と時刻を持ってよい層だが、**再現できることが命**なので、
  // 種から導かない乱数と実時刻だけは禁じる（ADR-0004 の裏返し）。
  {
    files: ['packages/core/sim/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'シミュレータは種から導く乱数だけを使う（sim/rng.ts）',
        },
        { object: 'Date', property: 'now', message: 'シミュレータは仮想時刻だけを使う' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date']", message: 'シミュレータは仮想時刻だけを使う' },
      ],
    },
  },

  // ---- シミュレータの I/O は入口 1 つに閉じる ----
  // 引数を読む・ファイルに書く・画面に出すのは `sim/main.ts` だけ。ほかは
  // すべて純粋な関数にしておく（CLAUDE.md 4 章「副作用は境界に集める」）。
  // ここを開けると、指標の計算の途中で読み書きが混ざり、テストできなくなる。
  {
    files: ['packages/core/sim/**/*.ts'],
    ignores: ['packages/core/sim/main.ts', 'packages/core/sim/**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'process', message: '引数と環境を読むのは sim/main.ts だけ' },
        { name: 'fetch', message: 'シミュレータは I/O を行わない' },
        { name: 'console', message: '画面に出すのは sim/main.ts だけ' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'Node の組み込みに触るのは sim/main.ts だけ' },
          ],
        },
      ],
    },
  },

  // ---- テスト ----
  // 時刻の偽装や重複した組み立てが必要になるため、長さの制約から外す。
  {
    files: ['**/*.test.ts'],
    rules: {
      'max-lines-per-function': 'off',
      complexity: 'off',
    },
  },

  // ---- スクリプトと設定ファイル（境界側） ----
  {
    files: ['scripts/**/*.mjs', '*.config.js', 'eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: {
      'max-lines-per-function': ['warn', { max: 20, skipBlankLines: true, skipComments: true }],
    },
  },
);
