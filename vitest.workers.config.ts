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
    setupFiles: ['./src/test/apply-migrations.ts'],
  },
});
