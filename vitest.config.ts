import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/sim/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/*/db/**/*.test.ts',
    ],
    environment: 'node',
    /**
     * 既定の 5 秒では、シミュレータの多数回まわす検査が CI の遅い機械で
     * 落ちる（100 回 × 3 時間半の仮想時間）。ハングを見逃さない範囲で広げる。
     */
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'packages/*/sim/**/*.ts', 'apps/*/db/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
