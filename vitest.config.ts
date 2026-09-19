import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/sim/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
    ],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'packages/*/sim/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
