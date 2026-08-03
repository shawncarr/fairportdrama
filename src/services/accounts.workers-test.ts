import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import { session, user } from '~/db/schema/auth';
import { members } from '~/db/schema/content';
import { auditEvents, APP_ROLE } from '~/db/schema/governance';
import { AUDIT_ACTOR_KIND, type Actor } from '~/lib/audit/actor';
import { AUDIT_ACTION } from '~/lib/audit/constants';
import { assignRole, linkMember, revokeAccess } from './accounts';

const db = () => getDb(env.DB);

const board: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'u_admin',
  label: 'Board Member',
  ip: '203.0.113.70',
  userAgent: 'Firefox',
};

const seedUser = async (id: string, email: string, role: string | null, memberId?: string) =>
  db().insert(user).values({
    id,
    email,
    name: '',
    emailVerified: true,
    role,
    memberId: memberId ?? null,
  });

const seedSession = async (id: string, userId: string) =>
  db().insert(session).values({
    id,
    userId,
    token: `tok_${id}`,
    expiresAt: new Date(Date.now() + 864e5),
    updatedAt: new Date(),
  });

const row = async (id: string) =>
  (await db().select().from(user).where(eq(user.id, id)))[0]!;

const audits = async () => db().select().from(auditEvents);

beforeEach(async () => {
  await env.DB.exec('DELETE FROM audit_events');
  await env.DB.exec('DELETE FROM session');
  await env.DB.exec('DELETE FROM account');
  await env.DB.exec('DELETE FROM user');
  await env.DB.exec('DELETE FROM members');

  await db().insert(members).values([
    { id: 'daniel-doser', name: 'Daniel Doser', grade: 'Senior' },
    { id: 'ari-toner', name: 'Ariana Toner', grade: 'Junior' },
  ]);
});

describe('assigning a role', () => {
  it('changes the role and records both values', async () => {
    await seedUser('u1', 'student@example.com', APP_ROLE.Member);
    await seedUser('u_admin', 'board@example.com', APP_ROLE.Admin);

    expect(await assignRole(db(), board, 'u1', APP_ROLE.Officer)).toEqual({ ok: true });
    expect((await row('u1')).role).toBe(APP_ROLE.Officer);

    const [audit] = await audits();
    expect(audit!.action).toBe(AUDIT_ACTION.AccountRoleChanged);
    expect(audit!.diff).toEqual({
      role: { before: APP_ROLE.Member, after: APP_ROLE.Officer },
    });
    expect(audit!.payload).toMatchObject({ email: 'student@example.com' });
  });

  it('writes nothing when the role is unchanged', async () => {
    await seedUser('u1', 'student@example.com', APP_ROLE.Member);
    expect(await assignRole(db(), board, 'u1', APP_ROLE.Member)).toEqual({ ok: true });
    expect(await audits()).toHaveLength(0);
  });

  it('refuses an unknown account', async () => {
    expect(await assignRole(db(), board, 'nope', APP_ROLE.Member)).toMatchObject({
      ok: false,
    });
  });
});

describe('the last admin', () => {
  it('cannot be demoted, since nobody could then manage accounts', async () => {
    await seedUser('u_admin', 'board@example.com', APP_ROLE.Admin);
    await seedUser('u1', 'student@example.com', APP_ROLE.Member);

    const result = await assignRole(db(), board, 'u_admin', APP_ROLE.Staff);
    expect(result).toMatchObject({ ok: false });
    expect((await row('u_admin')).role).toBe(APP_ROLE.Admin);
  });

  it('cannot have their access revoked either', async () => {
    await seedUser('u_admin', 'board@example.com', APP_ROLE.Admin);

    expect(await revokeAccess(db(), board, 'u_admin')).toMatchObject({ ok: false });
    expect((await row('u_admin')).role).toBe(APP_ROLE.Admin);
  });

  it('can hand over by promoting someone else first', async () => {
    await seedUser('u_admin', 'board@example.com', APP_ROLE.Admin);
    await seedUser('u2', 'newboard@example.com', APP_ROLE.Staff);

    expect(await assignRole(db(), board, 'u2', APP_ROLE.Admin)).toEqual({ ok: true });
    // No longer the only admin, so stepping down is now allowed.
    expect(await assignRole(db(), board, 'u_admin', APP_ROLE.Staff)).toEqual({ ok: true });
    expect((await row('u_admin')).role).toBe(APP_ROLE.Staff);
  });

  it('is not blocked when several admins exist', async () => {
    await seedUser('u_admin', 'board@example.com', APP_ROLE.Admin);
    await seedUser('u2', 'other@example.com', APP_ROLE.Admin);

    expect(await assignRole(db(), board, 'u2', null)).toEqual({ ok: true });
  });

  it('does not block promoting an admin to admin', async () => {
    await seedUser('u_admin', 'board@example.com', APP_ROLE.Admin);
    expect(await assignRole(db(), board, 'u_admin', APP_ROLE.Admin)).toEqual({ ok: true });
  });
});

describe('revoking access', () => {
  beforeEach(async () => {
    await seedUser('u_admin', 'board@example.com', APP_ROLE.Admin);
    await seedUser('u1', 'student@example.com', APP_ROLE.Officer);
    await seedSession('s1', 'u1');
    await seedSession('s2', 'u1');
    await seedSession('s3', 'u_admin');
    await env.DB.exec('DELETE FROM audit_events');
  });

  it('drops the role to none and keeps the account', async () => {
    expect(await revokeAccess(db(), board, 'u1')).toEqual({ ok: true });

    const after = await row('u1');
    expect(after.role).toBeNull();
    // The row survives so this is reversible and old audit rows still resolve.
    expect(after.email).toBe('student@example.com');
  });

  it('ends their sessions so access stops now, not when a cookie expires', async () => {
    await revokeAccess(db(), board, 'u1');

    const left = await db().select().from(session);
    expect(left.map((s) => s.userId)).toEqual(['u_admin']);
  });

  it('records how many sessions were torn down', async () => {
    await revokeAccess(db(), board, 'u1');

    const [audit] = await audits();
    expect(audit!.payload).toMatchObject({ accessRevoked: true, sessionsEnded: 2 });
    expect(audit!.diff).toEqual({ role: { before: APP_ROLE.Officer, after: null } });
  });

  it('can be undone by assigning a role again', async () => {
    await revokeAccess(db(), board, 'u1');
    await assignRole(db(), board, 'u1', APP_ROLE.Member);
    expect((await row('u1')).role).toBe(APP_ROLE.Member);
  });
});

describe('linking a member', () => {
  beforeEach(async () => {
    await seedUser('u1', 'student@example.com', APP_ROLE.Member);
    await seedUser('u2', 'other@example.com', APP_ROLE.Member);
  });

  it('links and audits it', async () => {
    expect(await linkMember(db(), board, 'u1', 'daniel-doser')).toEqual({ ok: true });
    expect((await row('u1')).memberId).toBe('daniel-doser');

    const [audit] = await audits();
    expect(audit!.action).toBe(AUDIT_ACTION.AccountMemberLinked);
  });

  it('unlinks under its own action, so the two read differently in the log', async () => {
    await linkMember(db(), board, 'u1', 'daniel-doser');
    await env.DB.exec('DELETE FROM audit_events');

    expect(await linkMember(db(), board, 'u1', null)).toEqual({ ok: true });
    expect((await row('u1')).memberId).toBeNull();

    const [audit] = await audits();
    expect(audit!.action).toBe(AUDIT_ACTION.AccountMemberUnlinked);
  });

  it('refuses a member already linked to another account', async () => {
    await linkMember(db(), board, 'u1', 'daniel-doser');

    // Two accounts on one profile would let two people edit the same student's
    // bio and make "who changed this" ambiguous.
    const result = await linkMember(db(), board, 'u2', 'daniel-doser');
    expect(result).toMatchObject({ ok: false });
    expect((await row('u2')).memberId).toBeNull();
  });

  it('names the account holding the link, so it can be sorted out', async () => {
    await linkMember(db(), board, 'u1', 'daniel-doser');
    const result = await linkMember(db(), board, 'u2', 'daniel-doser');

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('student@example.com');
  });

  it('allows relinking after the first account is unlinked', async () => {
    await linkMember(db(), board, 'u1', 'daniel-doser');
    await linkMember(db(), board, 'u1', null);

    expect(await linkMember(db(), board, 'u2', 'daniel-doser')).toEqual({ ok: true });
  });

  it('lets an account keep its own link when resubmitted', async () => {
    await linkMember(db(), board, 'u1', 'daniel-doser');
    expect(await linkMember(db(), board, 'u1', 'daniel-doser')).toEqual({ ok: true });
  });

  it('refuses a member record that does not exist', async () => {
    expect(await linkMember(db(), board, 'u1', 'nobody')).toMatchObject({ ok: false });
  });

  it('switches an account from one member to another', async () => {
    await linkMember(db(), board, 'u1', 'daniel-doser');
    expect(await linkMember(db(), board, 'u1', 'ari-toner')).toEqual({ ok: true });
    expect((await row('u1')).memberId).toBe('ari-toner');
  });
});
