import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '~/index';
import { getDb } from '~/db/queries';
import { MEMBER_VISIBILITY, members } from '~/db/schema/content';
import { resetTables } from '~/test/session';

/**
 * The incident, end to end: a member page whose first read D1 drops.
 *
 * The unit tests pin what `withReadRetry` does to a statement. This one runs
 * the real route through the real middleware chain against the real database,
 * with the failure injected where it actually happened, and asserts the thing
 * the visitor cares about - that the page arrives.
 */

/** The real binding, with the first `n` reads failing the way D1 failed. */
const flakyD1 = (reason: string, failures: number): D1Database => {
  let left = failures;
  const drop = () => left-- > 0;

  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
    ({
      bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
      all: () => (drop() ? Promise.reject(new Error(reason)) : stmt.all()),
      raw: (options?: never) => (drop() ? Promise.reject(new Error(reason)) : stmt.raw(options)),
      run: () => stmt.run(),
      first: (colName?: string) =>
        colName === undefined ? stmt.first() : stmt.first(colName),
    }) as unknown as D1PreparedStatement;

  return {
    prepare: (sql: string) => wrap(env.DB.prepare(sql)),
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
    exec: (query: string) => env.DB.exec(query),
    withSession: (c?: Parameters<D1Database['withSession']>[0]) => env.DB.withSession(c),
    dump: () => env.DB.dump(),
  } as D1Database;
};

const request = () =>
  new Request('https://fairportdrama.com/members/abigail-grabert', { redirect: 'manual' });

describe('a member page when D1 drops a read', () => {
  beforeEach(async () => {
    await resetTables(['member_offices', 'member_roles', 'members']);
    await getDb(env.DB).insert(members).values({
      id: 'abigail-grabert',
      name: 'Abigail Grabert',
      grade: 'Freshman',
      visibility: MEMBER_VISIBILITY.Full,
      isActive: true,
    });
  });

  it('still serves the page', async () => {
    const res = await app.fetch(request(), { ...env, DB: flakyD1('Network connection lost.', 1) });

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain('Abigail Grabert');
  });

  it('recovers from a run of failures, not just one', async () => {
    const res = await app.fetch(request(), { ...env, DB: flakyD1('Network connection lost.', 2) });

    expect(res.status).toBe(200);
  });

  it('gives up once the failures outlast the retries', async () => {
    const res = await app.fetch(request(), { ...env, DB: flakyD1('Network connection lost.', 9) });

    expect(res.status).toBe(500);
  });

  it('does not retry a failure that is about the query', async () => {
    const res = await app.fetch(request(), {
      ...env,
      DB: flakyD1('D1_ERROR: no such column: nonsense', 1),
    });

    expect(res.status).toBe(500);
  });
});
