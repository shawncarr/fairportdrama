import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import { members } from '~/db/schema/content';
import { invites, APP_ROLE } from '~/db/schema/governance';
import { auditEvents } from '~/db/schema/governance';
import { AUDIT_ACTION } from '~/lib/audit/constants';
import { AUDIT_ACTOR_KIND, type Actor } from '~/lib/audit/actor';
import { createInvite, inviteStatus, revokeInvite } from './invites';

const db = () => getDb(env.DB);

/**
 * Explicit fake rather than a spy on `env.EMAIL`.
 *
 * Spying on the live binding does not work here: `env.EMAIL` yields a
 * different object depending on when it is read, so the spy patched one
 * instance while the code under test called another - recording nothing while
 * the real send succeeded, which made a failure-path test silently assert the
 * success path. Passing the binding in explicitly removes the ambiguity.
 */
const fakeEmail = (behaviour: 'ok' | 'fail' = 'ok') => {
  const sent: string[] = [];
  const binding = {
    send: async (message: unknown) => {
      if (behaviour === 'fail') {
        throw Object.assign(new Error('nope'), { code: 'E_DELIVERY_FAILED' });
      }
      sent.push(String((message as { to: unknown }).to));
      return { messageId: 'test' };
    },
  } as unknown as SendEmail;
  return { binding, sent };
};

let email = fakeEmail();

const admin: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'user_admin',
  label: 'Board Member',
  ip: '203.0.113.1',
  userAgent: 'test',
};

const send = (over: Partial<Parameters<typeof createInvite>[4]> = {}) =>
  createInvite(db(), admin, email.binding, 'https://fairportdrama.com', {
    email: 'newperson@example.com',
    role: APP_ROLE.Member,
    memberId: null,
    ...over,
  });

beforeEach(async () => {
  email = fakeEmail();
  await env.DB.exec('DELETE FROM audit_events');
  await env.DB.exec('DELETE FROM invites');
  await env.DB.exec('DELETE FROM members');
  await db().insert(members).values({
    id: 'daniel-doser',
    name: 'Daniel Doser',
    grade: 'Senior',
  });
});

describe('creating an invite', () => {
  it('stores it and emails the recipient', async () => {
    const result = await send();
    expect(result.ok).toBe(true);
    expect(email.sent).toEqual(['newperson@example.com']);

    const [row] = await db().select().from(invites);
    expect(row!.role).toBe(APP_ROLE.Member);
    expect(row!.acceptedAt).toBeNull();
  });

  it('normalises the address so casing cannot create a duplicate', async () => {
    await send({ email: '  NewPerson@Example.COM ' });
    const [row] = await db().select().from(invites);
    expect(row!.email).toBe('newperson@example.com');
  });

  it('records who was invited, but never the token', async () => {
    await send();
    const [row] = await db().select().from(auditEvents);
    expect(row!.action).toBe(AUDIT_ACTION.AccountInvited);

    const payload = row!.payload as Record<string, unknown>;
    expect(payload.email).toBe('newperson@example.com');
    // The token is a credential; it must not be duplicated into the log.
    const [invite] = await db().select().from(invites);
    expect(JSON.stringify(row)).not.toContain(invite!.token);
  });

  it('sets an expiry rather than issuing a standing credential', async () => {
    await send();
    const [row] = await db().select().from(invites);
    expect(new Date(row!.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('can link a member profile', async () => {
    await send({ memberId: 'daniel-doser' });
    const [row] = await db().select().from(invites);
    expect(row!.memberId).toBe('daniel-doser');
  });

  it('rejects a link to a member who does not exist', async () => {
    const result = await send({ memberId: 'ghost' });
    expect(result.ok).toBe(false);
    expect(await db().select().from(invites)).toHaveLength(0);
  });
});

describe('duplicate invites', () => {
  // Two open invites for one address would leave two usable credentials.
  it('refuses a second open invite for the same address', async () => {
    await send();
    const second = await send();
    expect(second.ok).toBe(false);
    expect(await db().select().from(invites)).toHaveLength(1);
  });

  it('allows a fresh invite once the previous one was revoked', async () => {
    const first = await send();
    if (!first.ok) throw new Error('setup failed');
    await revokeInvite(db(), admin, first.inviteId);

    const second = await send();
    expect(second.ok).toBe(true);
    expect(await db().select().from(invites)).toHaveLength(2);
  });
});

describe('when the email fails', () => {
  // The invite must survive: rolling back would lose the record of who was
  // invited and leave no way to resend.
  it('keeps the invite and reports the failure', async () => {
    email = fakeEmail('fail');

    const result = await send();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.emailed).toBe(false);
    expect(await db().select().from(invites)).toHaveLength(1);
  });
});

describe('revoking', () => {
  it('marks it revoked and audits the action', async () => {
    const created = await send();
    if (!created.ok) throw new Error('setup failed');

    expect((await revokeInvite(db(), admin, created.inviteId)).revoked).toBe(true);

    const [row] = await db()
      .select()
      .from(invites)
      .where(eq(invites.id, created.inviteId));
    expect(row!.revokedAt).not.toBeNull();

    const actions = (await db().select().from(auditEvents)).map((a) => a.action);
    expect(actions).toContain(AUDIT_ACTION.AccountInviteRevoked);
  });

  it('cannot revoke twice', async () => {
    const created = await send();
    if (!created.ok) throw new Error('setup failed');
    await revokeInvite(db(), admin, created.inviteId);
    expect((await revokeInvite(db(), admin, created.inviteId)).revoked).toBe(false);
  });

  it('ignores an unknown id', async () => {
    expect((await revokeInvite(db(), admin, 'nope')).revoked).toBe(false);
  });
});

describe('inviteStatus', () => {
  const base = { acceptedAt: null, revokedAt: null, expiresAt: '2099-01-01T00:00:00Z' };

  it('reports open for a usable invite', () => {
    expect(inviteStatus(base)).toBe('open');
  });

  it('reports expired once the window passes', () => {
    expect(inviteStatus({ ...base, expiresAt: '2020-01-01T00:00:00Z' })).toBe('expired');
  });

  it('reports accepted', () => {
    expect(inviteStatus({ ...base, acceptedAt: '2026-01-01T00:00:00Z' })).toBe('accepted');
  });

  // Revocation outranks acceptance so a revoked invite never reads as usable.
  it('reports revoked even if also accepted', () => {
    expect(
      inviteStatus({
        ...base,
        acceptedAt: '2026-01-01T00:00:00Z',
        revokedAt: '2026-02-01T00:00:00Z',
      }),
    ).toBe('revoked');
  });
});
