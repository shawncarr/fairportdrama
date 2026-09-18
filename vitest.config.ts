import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      // Matches esbuild's `--loader:.svg=text` in build:editor, so the editor's
      // icon imports are markup under test too rather than asset URLs.
      name: 'svg-as-text',
      enforce: 'pre',
      load(id) {
        if (!id.endsWith('.svg')) return null;
        return `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`;
      },
    },
  ],
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
