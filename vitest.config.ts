import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '~': new URL('./src', import.meta.url).pathname },
  },
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      // istanbul, to match the workers config so the two runs merge.
      provider: 'istanbul',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.workers-test.ts',
        'src/test/**',
        'src/env.ts',
        'src/db/schema/**',
      ],
      // Count every source file, not only the ones a test happens to import.
      // Without this the denominator moves as tests are added, and adding a
      // test that loads a new module can make the percentage fall.
      all: true,
      reporter: ['text-summary', 'json'],
    },
  },
});
