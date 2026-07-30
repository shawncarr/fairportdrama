/**
 * Test-only bindings.
 *
 * The bindings declared in wrangler.jsonc are generated into
 * worker-configuration.d.ts by `wrangler types`. TEST_MIGRATIONS is injected by
 * miniflare from vitest.workers.config.ts and exists only under test, so it is
 * declared here rather than added to the real configuration.
 */
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
