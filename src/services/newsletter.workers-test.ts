import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import { newsletterSubscribers } from '~/db/schema/newsletter';
import { auditEvents } from '~/db/schema/governance';
import { AUDIT_ACTOR_KIND, systemActor, type Actor } from '~/lib/audit/actor';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import {
  countSubscribers,
  findByToken,
  listSubscribers,
  subscribe,
  unsubscribeByEmail,
  unsubscribeByToken,
} from './newsletter';

const db = () => getDb(env.DB);

/** Public endpoints run as the system actor; the IP is the only attribution. */
const visitor: Actor = systemActor('203.0.113.99', 'Firefox');

const board: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'u_board',
  label: 'Board Member',
  ip: '203.0.113.7',
  userAgent: 'Firefox',
};

const rows = () => db().select().from(newsletterSubscribers);
const audits = async () => db().select().from(auditEvents);
const find = async (email: string) =>
  (await db().select().from(newsletterSubscribers).where(eq(newsletterSubscribers.email, email)))[0];

beforeEach(async () => {
  await env.DB.exec('DELETE FROM audit_events');
  await env.DB.exec('DELETE FROM newsletter_subscribers');
});

describe('subscribing', () => {
  it('adds the address and issues an unsubscribe token', async () => {
    await subscribe(db(), visitor, { email: 'Someone@Example.com ' });

    const row = await find('someone@example.com');
    expect(row!.email).toBe('someone@example.com');
    expect(row!.confirmationToken).toBeTruthy();
  });

  it('is audited, with the IP as the only attribution available', async () => {
    await subscribe(db(), visitor, { email: 'a@example.com', source: 'footer' });

    const [audit] = await audits();
    expect(audit!.action).toBe(AUDIT_ACTION.NewsletterSubscribed);
    expect(audit!.targetKind).toBe(AUDIT_ENTITY_KIND.NewsletterSubscriber);
    expect(audit!.targetId).toBe('a@example.com');
    expect(audit!.actorKind).toBe('system');
    expect(audit!.ip).toBe('203.0.113.99');
    expect(audit!.payload).toMatchObject({ source: 'footer' });
  });

  it('does not duplicate or re-audit an address already on the list', async () => {
    await subscribe(db(), visitor, { email: 'a@example.com' });
    await env.DB.exec('DELETE FROM audit_events');

    await subscribe(db(), visitor, { email: 'a@example.com' });
    expect(await rows()).toHaveLength(1);
    expect(await audits()).toHaveLength(0);
  });

  it('answers identically for a new and an existing address', async () => {
    const first = await subscribe(db(), visitor, { email: 'a@example.com' });
    const second = await subscribe(db(), visitor, { email: 'a@example.com' });

    // Otherwise the endpoint tells you whether somebody is on the list.
    expect(second.message).toBe(first.message);
  });

  it('clears a previous unsubscribe rather than reporting a duplicate', async () => {
    await subscribe(db(), visitor, { email: 'a@example.com' });
    const token = (await find('a@example.com'))!.confirmationToken!;
    await unsubscribeByToken(db(), visitor, token);

    await subscribe(db(), visitor, { email: 'a@example.com' });
    expect((await find('a@example.com'))!.unsubscribedAt).toBeNull();
  });

  it('issues a token on resubscribe for a row migrated without one', async () => {
    // The three rows carried over from the Astro site have no token at all.
    await db().insert(newsletterSubscribers).values({
      email: 'old@example.com',
      subscribedAt: '2024-01-01',
      unsubscribedAt: '2024-06-01',
      createdAt: '2024-01-01',
      updatedAt: '2024-06-01',
    });

    await subscribe(db(), visitor, { email: 'old@example.com' });
    expect((await find('old@example.com'))!.confirmationToken).toBeTruthy();
  });
});

describe('unsubscribing by token', () => {
  const setup = async () => {
    await subscribe(db(), visitor, { email: 'a@example.com' });
    await env.DB.exec('DELETE FROM audit_events');
    return (await find('a@example.com'))!.confirmationToken!;
  };

  it('marks the row unsubscribed and audits it', async () => {
    const token = await setup();
    expect(await unsubscribeByToken(db(), visitor, token)).toEqual({
      unsubscribed: true,
      email: 'a@example.com',
    });

    expect((await find('a@example.com'))!.unsubscribedAt).toBeTruthy();
    const [audit] = await audits();
    expect(audit!.action).toBe(AUDIT_ACTION.NewsletterUnsubscribed);
    expect(audit!.payload).toMatchObject({ self: true });
  });

  it('keeps the row, so the address is not silently re-added later', async () => {
    const token = await setup();
    await unsubscribeByToken(db(), visitor, token);
    expect(await rows()).toHaveLength(1);
  });

  it('does nothing for an unknown or empty token', async () => {
    await setup();
    for (const t of ['', 'nope']) {
      expect((await unsubscribeByToken(db(), visitor, t)).unsubscribed).toBe(false);
    }
    expect(await audits()).toHaveLength(0);
  });

  it('cannot be used twice', async () => {
    const token = await setup();
    await unsubscribeByToken(db(), visitor, token);
    expect((await unsubscribeByToken(db(), visitor, token)).unsubscribed).toBe(false);
  });

  it('is the only way in, since the email is not accepted as a key', async () => {
    await setup();
    // Guessing someone's address must not be enough to remove them.
    expect((await unsubscribeByToken(db(), visitor, 'a@example.com')).unsubscribed).toBe(false);
    expect((await find('a@example.com'))!.unsubscribedAt).toBeNull();
  });
});

describe('unsubscribing on request from an admin', () => {
  it('records that it was not the subscriber who did it', async () => {
    await subscribe(db(), visitor, { email: 'a@example.com' });
    await env.DB.exec('DELETE FROM audit_events');

    expect(await unsubscribeByEmail(db(), board, 'A@Example.com')).toEqual({
      unsubscribed: true,
    });

    const [audit] = await audits();
    // "Did I unsubscribe, or did someone do it for me" is the question a
    // complaint actually asks.
    expect(audit!.payload).toMatchObject({ self: false });
    expect(audit!.actorUserId).toBe('u_board');
  });

  it('ignores an address that is not on the list', async () => {
    expect((await unsubscribeByEmail(db(), board, 'nobody@example.com')).unsubscribed).toBe(
      false,
    );
  });
});

describe('listing', () => {
  beforeEach(async () => {
    await subscribe(db(), visitor, { email: 'anna@example.com', name: 'Anna Smith' });
    await subscribe(db(), visitor, { email: 'bob@example.com', name: 'Bob Jones' });
    const token = (await find('bob@example.com'))!.confirmationToken!;
    await unsubscribeByToken(db(), visitor, token);
  });

  it('defaults to everyone when no status is given', async () => {
    expect(await listSubscribers(db())).toHaveLength(2);
  });

  it('filters to active only', async () => {
    const active = await listSubscribers(db(), { status: 'active' });
    expect(active.map((r) => r.email)).toEqual(['anna@example.com']);
  });

  it('filters to unsubscribed only', async () => {
    const gone = await listSubscribers(db(), { status: 'unsubscribed' });
    expect(gone.map((r) => r.email)).toEqual(['bob@example.com']);
  });

  it('searches email and name, case-insensitively', async () => {
    expect((await listSubscribers(db(), { search: 'ANNA' })).length).toBe(1);
    expect((await listSubscribers(db(), { search: 'jones' })).length).toBe(1);
    expect((await listSubscribers(db(), { search: 'zzz' })).length).toBe(0);
  });

  it('counts total and active separately', async () => {
    expect(await countSubscribers(db())).toEqual({ total: 2, active: 1 });
  });

  it('finds a row by its token', async () => {
    const row = await find('anna@example.com');
    expect((await findByToken(db(), row!.confirmationToken!))!.email).toBe(
      'anna@example.com',
    );
    expect(await findByToken(db(), 'nope')).toBeNull();
    expect(await findByToken(db(), '')).toBeNull();
  });
});
