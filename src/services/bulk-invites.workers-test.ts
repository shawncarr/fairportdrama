import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '~/db/queries';
import { members, MEMBER_VISIBILITY } from '~/db/schema/content';
import { invites, APP_ROLE } from '~/db/schema/governance';
import { user } from '~/db/schema/auth';
import { auditEvents } from '~/db/schema/governance';
import { AUDIT_ACTOR_KIND, type Actor } from '~/lib/audit/actor';
import { AUDIT_ACTION } from '~/lib/audit/constants';
import { generateId } from '~/lib/id';
import { planBulkInvites, sendBulkInvites } from './invites';
import { resolveMemberRef } from './members';
import { resetTables } from '~/test/session';

/**
 * Inviting a whole club at once.
 *
 * An invite is a credential, so the thing that matters is that the preview and
 * the send agree: the count on the confirmation screen has to be the number of
 * people who end up with access.
 */

const db = () => getDb(env.DB);

const board: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'u_board',
  label: 'Board Member',
  ip: '203.0.113.10',
  userAgent: 'Firefox',
};

const openInvite = async (email: string) =>
  db().insert(invites).values({
    id: generateId(),
    email,
    role: APP_ROLE.Member,
    memberId: null,
    token: generateId(),
    expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
    createdByUserId: 'seed',
    createdAt: new Date().toISOString(),
  });

const account = async (email: string) =>
  db().insert(user).values({
    id: generateId(),
    email,
    name: 'Someone',
    emailVerified: true,
    role: APP_ROLE.Member,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

beforeEach(async () => {
  await resetTables(['member_offices', 'member_roles', 'members']);
});

describe('planning a pasted list', () => {
  it('takes one address per line', async () => {
    const plan = await planBulkInvites(db(), 'ada@x.org\nben@x.org\ncai@x.org');

    expect(plan.counts.invite).toBe(3);
    expect(plan.toInvite).toEqual(['ada@x.org', 'ben@x.org', 'cai@x.org']);
  });

  it('accepts commas and semicolons, which is how lists arrive', async () => {
    const plan = await planBulkInvites(db(), 'ada@x.org, ben@x.org; cai@x.org');
    expect(plan.counts.invite).toBe(3);
  });

  it('ignores blank lines and stray whitespace', async () => {
    const plan = await planBulkInvites(db(), '\n  ada@x.org  \n\n\n  ben@x.org\n');
    expect(plan.toInvite).toEqual(['ada@x.org', 'ben@x.org']);
  });

  it('lowercases, so the same address twice in different case is one invite', async () => {
    const plan = await planBulkInvites(db(), 'Ada@X.org\nada@x.ORG');

    expect(plan.counts.invite).toBe(1);
    expect(plan.counts.duplicate).toBe(1);
  });

  it('skips someone who already has an account', async () => {
    await account('ada@x.org');
    const plan = await planBulkInvites(db(), 'ada@x.org\nben@x.org');

    expect(plan.counts['has-account']).toBe(1);
    expect(plan.toInvite).toEqual(['ben@x.org']);
  });

  it('skips someone with an open invite rather than issuing a second credential', async () => {
    await openInvite('ada@x.org');
    const plan = await planBulkInvites(db(), 'ada@x.org\nben@x.org');

    expect(plan.counts['already-invited']).toBe(1);
    expect(plan.toInvite).toEqual(['ben@x.org']);
  });

  it('does not treat an expired invite as blocking', async () => {
    await db().insert(invites).values({
      id: generateId(),
      email: 'ada@x.org',
      role: APP_ROLE.Member,
      memberId: null,
      token: generateId(),
      expiresAt: new Date(Date.now() - 864e5).toISOString(),
      createdByUserId: 'seed',
      createdAt: new Date().toISOString(),
    });

    // Expiry is the point of the TTL: an invite nobody used has to be
    // reissuable, or a student who missed it is locked out.
    expect((await planBulkInvites(db(), 'ada@x.org')).counts.invite).toBe(1);
  });

  it('rejects lines that are not addresses, and says which line', async () => {
    const plan = await planBulkInvites(db(), 'ada@x.org\nDaniel Doser\nben@x\ncai@x.org');

    expect(plan.counts.invalid).toBe(2);
    expect(plan.entries.filter((e) => e.outcome === 'invalid').map((e) => e.line)).toEqual([
      2, 3,
    ]);
    expect(plan.toInvite).toEqual(['ada@x.org', 'cai@x.org']);
  });

  it('writes nothing at all', async () => {
    await planBulkInvites(db(), 'ada@x.org\nben@x.org');

    expect(await db().select().from(invites)).toHaveLength(0);
    expect(await db().select().from(auditEvents)).toHaveLength(0);
  });

  it('keeps every line in the report, so a skip can be explained', async () => {
    await account('ada@x.org');
    const plan = await planBulkInvites(db(), 'ada@x.org\nnonsense\nben@x.org');

    expect(plan.entries).toHaveLength(3);
    expect(plan.entries.map((e) => e.outcome)).toEqual(['has-account', 'invalid', 'invite']);
    expect(plan.entries[1]!.raw).toBe('nonsense');
  });
});

describe('sending what the plan named', () => {
  it('creates one invite per address, with the chosen role', async () => {
    const result = await sendBulkInvites(
      db(), board, env.EMAIL, 'https://example.org',
      ['ada@x.org', 'ben@x.org'], APP_ROLE.Member,
    );

    expect(result.created).toBe(2);
    const rows = await db().select().from(invites);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.role === APP_ROLE.Member)).toBe(true);
  });

  it('audits each one, so a bulk grant is not one anonymous event', async () => {
    await sendBulkInvites(
      db(), board, env.EMAIL, 'https://example.org',
      ['ada@x.org', 'ben@x.org'], APP_ROLE.Officer,
    );

    const rows = await db().select().from(auditEvents);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.action === AUDIT_ACTION.AccountInvited)).toBe(true);
    expect(rows.every((r) => r.actorUserId === 'u_board')).toBe(true);
  });

  it('carries on past one that fails rather than abandoning the rest', async () => {
    await openInvite('ben@x.org');

    const result = await sendBulkInvites(
      db(), board, env.EMAIL, 'https://example.org',
      ['ada@x.org', 'ben@x.org', 'cai@x.org'], APP_ROLE.Member,
    );

    // Stopping at the first failure would leave the club half-invited with no
    // way to tell who got one.
    expect(result.created).toBe(2);
    expect(result.failed.map((f) => f.email)).toEqual(['ben@x.org']);
  });

  it('sends the count the preview promised', async () => {
    await account('ada@x.org');
    const plan = await planBulkInvites(db(), 'ada@x.org\nben@x.org\ncai@x.org');

    const result = await sendBulkInvites(
      db(), board, env.EMAIL, 'https://example.org', plan.toInvite, APP_ROLE.Member,
    );

    expect(result.created).toBe(plan.counts.invite);
  });
});

describe('resolving a typed member name', () => {
  beforeEach(async () => {
    await db().insert(members).values([
      { id: 'ada-lovelace', name: 'Ada Lovelace', grade: 'Senior', visibility: MEMBER_VISIBILITY.Full, isActive: true },
      { id: 'ben-bell', name: 'Ben Bell', grade: 'Junior', visibility: MEMBER_VISIBILITY.Full, isActive: true },
      { id: 'gone-gil', name: 'Gil Gone', grade: 'Alumni', visibility: MEMBER_VISIBILITY.Full, isActive: false },
    ]);
  });

  it('takes an exact name', async () => {
    expect(await resolveMemberRef(db(), 'Ada Lovelace')).toEqual({ ok: true, id: 'ada-lovelace' });
  });

  it('takes the profile id too', async () => {
    expect(await resolveMemberRef(db(), 'ada-lovelace')).toEqual({ ok: true, id: 'ada-lovelace' });
  });

  it('ignores case and surrounding space', async () => {
    expect(await resolveMemberRef(db(), '  ada lovelace ')).toEqual({
      ok: true,
      id: 'ada-lovelace',
    });
  });

  it('treats an empty field as no link', async () => {
    expect(await resolveMemberRef(db(), '   ')).toEqual({ ok: true, id: null });
  });

  it('refuses a name nobody has, rather than linking to nobody', async () => {
    const result = await resolveMemberRef(db(), 'Nobody Here');
    expect(result).toMatchObject({ ok: false });
  });

  it('will not resolve an inactive member', async () => {
    expect(await resolveMemberRef(db(), 'Gil Gone')).toMatchObject({ ok: false });
  });

  it('refuses an ambiguous name and names the ids to choose between', async () => {
    await db().insert(members).values({
      id: 'ada-lovelace-2', name: 'Ada Lovelace', grade: 'Freshman',
      visibility: MEMBER_VISIBILITY.Full, isActive: true,
    });

    const result = await resolveMemberRef(db(), 'Ada Lovelace');

    // Guessing would attach one student's account to another's profile, and
    // the only visible sign of it would be on the other student's page.
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toContain('ada-lovelace');
      expect(result.error).toContain('ada-lovelace-2');
    }
  });
});
