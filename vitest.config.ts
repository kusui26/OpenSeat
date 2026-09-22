import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/sim/**/*.test.ts',
      // アプリの中は層が増えていく（`db` / `venue` / `routes` / 画面）。**置き場所を
      // 数え上げない。** 数え上げると、層を足したときにテストが静かに走らなくなる。
      // `.tsx` も拾う —— 画面の部品はそちらにある。
      'apps/*/**/*.test.ts',
      'apps/*/**/*.test.tsx',
    ],
    environment: 'node',
    /**
     * 既定の 5 秒では、シミュレータの多数回まわす検査が CI の遅い機械で
     * 落ちる（100 回 × 3 時間半の仮想時間）。ハングを見逃さない範囲で広げる。
     */
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: [
        'packages/*/src/**/*.ts',
        'packages/*/sim/**/*.ts',
        'apps/*/{db,venue,src}/**/*.ts',
        'apps/*/src/**/*.tsx',
      ],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
