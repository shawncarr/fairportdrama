import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '~/db/schema';
import { invites, APP_ROLE } from '~/db/schema/governance';
import { generateId } from '~/lib/id';
import { createAuth } from './index';

/**
 * The magic-link endpoint is public and unauthenticated. Without a guard it
 * will send mail to any address supplied by any caller - the invite gate stops
 * the account from being created, but only after the email has already gone
 * out.
 *
 * These tests assert on what the EMAIL binding actually received, since
 * "returns 200" tells you nothing about whether mail was sent.
 */

const db = () => drizzle(env.DB, { schema });

/** Captures sends without delivering, so the assertion is on real calls. */
const captureEmails = () => {
  const sent: string[] = [];
  vi.spyOn(env.EMAIL, 'send').mockImplementation(async (message: unknown) => {
    const to = (message as { to?: unknown }).to;
    sent.push(String(Array.isArray(to) ? to[0] : to));
    return { messageId: 'test' } as never;
  });
  return sent;
};

const requestLink = async (email: string) => {
  const auth = createAuth(env as never);
  return auth.api
    .signInMagicLink({ body: { email, callbackURL: '/admin' }, headers: new Headers() })
    .catch(() => undefined);
};

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec('DELETE FROM invites');
  await env.DB.exec('DELETE FROM user');
  await env.DB.exec('DELETE FROM verification');
});

describe('magic link cannot be used to send mail to arbitrary addresses', () => {
  it('sends nothing to an address with no invite and no account', async () => {
    const sent = captureEmails();
    await requestLink('stranger@example.com');
    expect(sent).toEqual([]);
  });

  it('sends nothing for a revoked invite', async () => {
    const sent = captureEmails();
    await db()
      .insert(invites)
      .values({
        id: generateId(),
        email: 'revoked@example.com',
        role: APP_ROLE.Member,
        memberId: null,
        token: generateId(),
        expiresAt: new Date(Date.now() + 864e5).toISOString(),
        revokedAt: new Date().toISOString(),
        createdByUserId: 'admin',
        createdAt: new Date().toISOString(),
      });
    await requestLink('revoked@example.com');
    expect(sent).toEqual([]);
  });

  it('sends nothing for an expired invite', async () => {
    const sent = captureEmails();
    await db()
      .insert(invites)
      .values({
        id: generateId(),
        email: 'expired@example.com',
        role: APP_ROLE.Member,
        memberId: null,
        token: generateId(),
        expiresAt: new Date(Date.now() - 864e5).toISOString(),
        createdByUserId: 'admin',
        createdAt: new Date().toISOString(),
      });
    await requestLink('expired@example.com');
    expect(sent).toEqual([]);
  });

  // The counterweight: the guard must not silence legitimate mail.
  it('does send to an address holding a usable invite', async () => {
    const sent = captureEmails();
    await db()
      .insert(invites)
      .values({
        id: generateId(),
        email: 'invited@example.com',
        role: APP_ROLE.Officer,
        memberId: null,
        token: generateId(),
        expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
        createdByUserId: 'admin',
        createdAt: new Date().toISOString(),
      });
    await requestLink('invited@example.com');
    expect(sent).toEqual(['invited@example.com']);
  });

  it('matches the invite regardless of the casing the caller supplies', async () => {
    const sent = captureEmails();
    await db()
      .insert(invites)
      .values({
        id: generateId(),
        email: 'cased@example.com',
        role: APP_ROLE.Member,
        memberId: null,
        token: generateId(),
        expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
        createdByUserId: 'admin',
        createdAt: new Date().toISOString(),
      });
    await requestLink('CASED@example.com');
    expect(sent).toHaveLength(1);
  });
});

describe('the endpoint does not leak who is invited', () => {
  // Suppressing the mail must not turn the endpoint into an oracle for
  // discovering which addresses hold accounts or invites.
  it('reports the same result whether or not an address is entitled', async () => {
    captureEmails();
    await db()
      .insert(invites)
      .values({
        id: generateId(),
        email: 'real@example.com',
        role: APP_ROLE.Member,
        memberId: null,
        token: generateId(),
        expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
        createdByUserId: 'admin',
        createdAt: new Date().toISOString(),
      });

    const auth = createAuth(env as never);
    const forInvited = await auth.handler(
      new Request('https://fairportdrama.com/api/auth/sign-in/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'real@example.com', callbackURL: '/admin' }),
      }),
    );
    const forStranger = await auth.handler(
      new Request('https://fairportdrama.com/api/auth/sign-in/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'stranger@example.com', callbackURL: '/admin' }),
      }),
    );

    expect(forStranger.status).toBe(forInvited.status);
    expect(await forStranger.text()).toBe(await forInvited.text());
  });
});
