import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Integration tests run in real workerd against a real D1 database.
//
// NOTE: @cloudflare/vitest-pool-workers v0.19 replaced `defineWorkersConfig`
// (imported from a `./config` subpath) with the `cloudflareTest` Vite plugin.
// Most published examples still show the old API.
const migrations = await readD1Migrations('./drizzle');

export default defineConfig({
  resolve: {
    alias: { '~': new URL('./src', import.meta.url).pathname },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        compatibilityFlags: ['nodejs_compat'],
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    include: ['src/**/*.workers-test.ts'],
    coverage: {
      // v8 coverage needs the V8 inspector Session API, which workerd does not
      // implement. Istanbul instruments at transform time instead.
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
    setupFiles: ['./src/test/apply-migrations.ts'],
  },
});
