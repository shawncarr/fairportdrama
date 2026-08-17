import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describeError } from '~/lib/errors';

/**
 * The reason a D1 failure is diagnosable at all.
 *
 * A burst of 500s on /members/:slug reached Workers Logs as a bare stack with
 * no message, because drizzle wraps the D1 error on `cause` and Cloudflare
 * serialises only an exception's name, message and stack. These assertions
 * pin the unwrapping that puts the real reason back in the log.
 */
describe('describeError', () => {
  it('recovers the error D1 raised, which drizzle buries on `cause`', () => {
    const err = new DrizzleQueryError(
      'select "id" from "members" where "id" = ?',
      ['abigail-grabert'],
      new Error('Network connection lost.'),
    );

    expect(describeError(err).causes).toEqual([
      { name: 'Error', message: 'Network connection lost.' },
    ]);
  });

  it('keeps the query text, which says which call site failed', () => {
    const err = new DrizzleQueryError('select "id" from "members"', [], new Error('boom'));

    expect(describeError(err).message).toContain('select "id" from "members"');
  });

  it('drops the bound parameters, which carry addresses and names', () => {
    const err = new DrizzleQueryError(
      'select "id" from "user" where "email" = ?',
      ['someone@example.com'],
      new Error('boom'),
    );

    expect(describeError(err).message).not.toContain('someone@example.com');
  });

  it('follows a chain deeper than one link', () => {
    const err = new Error('outer', { cause: new Error('middle', { cause: new Error('inner') }) });

    expect(describeError(err).causes.map((c) => c.message)).toEqual(['middle', 'inner']);
  });

  it('terminates on a cycle rather than walking it forever', () => {
    const outer = new Error('outer');
    const inner = new Error('inner');
    outer.cause = inner;
    inner.cause = outer;

    expect(describeError(outer).causes.map((c) => c.message)).toEqual(['inner']);
  });

  it('describes a throw that was never an Error', () => {
    expect(describeError('just a string')).toEqual({
      name: 'string',
      message: 'just a string',
      causes: [],
    });
  });
});
