import { describe, expect, it, vi } from 'vitest';
import { withReadRetry } from '~/db/retry';

/**
 * A stand-in D1 binding that records what it was asked to do.
 *
 * `fail` is consumed one entry per execution, so a test says "fail like this
 * twice, then succeed" and asserts on the number of attempts.
 */
const fakeD1 = (fail: (Error | null)[] = []) => {
  const calls: { sql: string; attempts: number }[] = [];
  const batched: unknown[] = [];

  const statement = (sql: string, bound: unknown[] = []) => {
    const self = {
      native: true,
      sql,
      bound,
      bind: (...values: unknown[]) => statement(sql, values),
      all: () => {
        const entry = calls.find((c) => c.sql === sql) ?? { sql, attempts: 0 };
        if (entry.attempts === 0) calls.push(entry);
        entry.attempts += 1;

        const next = fail.shift();
        return next ? Promise.reject(next) : Promise.resolve({ results: [] });
      },
      raw: () => self.all(),
      run: () => self.all(),
      first: () => self.all(),
    };
    return self;
  };

  const binding = {
    prepare: (sql: string) => statement(sql),
    batch: (statements: unknown[]) => {
      batched.push(...statements);
      return Promise.resolve([]);
    },
  };

  return { binding: binding as never, calls, batched };
};

const attemptsFor = (calls: { sql: string; attempts: number }[], sql: string) =>
  calls.find((c) => c.sql === sql)?.attempts ?? 0;

const transient = () => new Error('Network connection lost.');

describe('withReadRetry', () => {
  it('retries a read that fails the way a D1 blip fails', async () => {
    const { binding, calls } = fakeD1([transient()]);
    const sql = 'select "id" from "members" where "id" = ?';

    await withReadRetry(binding).prepare(sql).bind('abigail-grabert').raw();

    expect(attemptsFor(calls, sql)).toBe(2);
  });

  it('gives up rather than hammering a database that stays down', async () => {
    const { binding, calls } = fakeD1([transient(), transient(), transient(), transient()]);
    const sql = 'select "id" from "members"';

    await expect(withReadRetry(binding).prepare(sql).raw()).rejects.toThrow(
      'Network connection lost.',
    );
    expect(attemptsFor(calls, sql)).toBe(3);
  });

  it('does not retry an error that will fail identically next time', async () => {
    const { binding, calls } = fakeD1([new Error('D1_ERROR: no such table: members')]);
    const sql = 'select "id" from "members"';

    await expect(withReadRetry(binding).prepare(sql).raw()).rejects.toThrow('no such table');
    expect(attemptsFor(calls, sql)).toBe(1);
  });

  it('does not retry into a database that is already overloaded', async () => {
    const { binding, calls } = fakeD1([new Error('D1 DB is overloaded. Too many requests queued.')]);
    const sql = 'select "id" from "members"';

    await expect(withReadRetry(binding).prepare(sql).raw()).rejects.toThrow('overloaded');
    expect(attemptsFor(calls, sql)).toBe(1);
  });

  it('never retries a write, which is not safe to repeat', async () => {
    const { binding, calls } = fakeD1([transient()]);
    const sql = 'insert into "audit_events" ("id") values (?)';

    await expect(withReadRetry(binding).prepare(sql).bind('x').run()).rejects.toThrow(
      'Network connection lost.',
    );
    expect(attemptsFor(calls, sql)).toBe(1);
  });

  it('hands batch the real statements, not the wrappers', async () => {
    const { binding, batched } = fakeD1();
    const db = withReadRetry(binding);

    await db.batch([
      db.prepare('select "id" from "members"').bind('a'),
      db.prepare('insert into "members" ("id") values (?)').bind('b'),
    ]);

    expect(batched).toHaveLength(2);
    expect(batched.every((s) => (s as { native?: boolean }).native === true)).toBe(true);
  });

  it('backs off instead of retrying immediately', async () => {
    const sleep = vi.spyOn(globalThis, 'setTimeout');
    const { binding } = fakeD1([transient()]);

    await withReadRetry(binding).prepare('select 1').raw();

    expect(sleep).toHaveBeenCalled();
    sleep.mockRestore();
  });
});
