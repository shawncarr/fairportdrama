import { applyD1Migrations, env } from 'cloudflare:test';

// Runs the real migration files against the test database, so integration
// tests exercise the same schema that production does rather than a
// hand-maintained copy that can silently drift.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
