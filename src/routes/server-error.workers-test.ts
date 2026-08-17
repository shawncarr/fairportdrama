import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '~/index';

/**
 * What a visitor and the logs get when a D1 read fails mid-request.
 *
 * Reproduces the incident this handler exists for: a burst of requests to
 * /members/:slug where the first query threw. The slugs were real and the
 * pages served fine before and after, so the fault was D1's, not the app's -
 * but nothing caught it, so visitors got a bare runtime error and the log
 * recorded a stack with no reason attached.
 */

/** A D1 binding that fails every read the way a transient D1 fault does. */
const failingD1 = (reason: string) => {
  const fail = () => Promise.reject(new Error(reason));
  const statement = { bind: () => statement, all: fail, raw: fail, run: fail, first: fail };
  return { prepare: () => statement, batch: fail, exec: fail } as unknown as D1Database;
};

const brokenEnv = (reason = 'Network connection lost.') => ({
  ...env,
  DB: failingD1(reason),
});

const request = (path: string, init?: RequestInit) =>
  new Request(`https://fairportdrama.com${path}`, { redirect: 'manual', ...init });

describe('unhandled errors', () => {
  let logged: unknown[][];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves a 500 page rather than a bare runtime error', async () => {
    const res = await app.fetch(request('/members/abigail-grabert'), brokenEnv());

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('text/html');
    await expect(res.text()).resolves.toContain('Something Went Wrong');
  });

  it('logs the D1 error, not just the query that carried it', async () => {
    await app.fetch(request('/members/abigail-grabert'), brokenEnv());

    const [entry] = logged.at(-1) as [{ path: string; causes: { message: string }[] }];
    expect(entry.path).toBe('/members/abigail-grabert');
    expect(entry.causes.map((c) => c.message)).toContain('Network connection lost.');
  });

  it('answers the JSON endpoints with JSON', async () => {
    const res = await app.fetch(
      request('/api/newsletter/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'someone@example.com' }),
      }),
      brokenEnv(),
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: 'Something went wrong. Please try again.',
    });
  });

  it('keeps the addresses a failed query was bound to out of the log', async () => {
    await app.fetch(
      request('/api/newsletter/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'someone@example.com' }),
      }),
      brokenEnv(),
    );

    expect(JSON.stringify(logged)).not.toContain('someone@example.com');
  });
});
