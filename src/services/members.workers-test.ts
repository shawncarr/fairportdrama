import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import { members, MEMBER_VISIBILITY } from '~/db/schema/content';
import { auditEvents } from '~/db/schema/governance';
import { AUDIT_ACTOR_KIND, type Actor } from '~/lib/audit/actor';
import { AUDIT_ACTION } from '~/lib/audit/constants';
import { createMember, reactivateMember } from './members';

const db = () => getDb(env.DB);

const officer: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'user_officer',
  label: 'Ariana Toner',
  ip: '203.0.113.50',
  userAgent: 'Chromebook',
};

const row = async (id: string) =>
  (await db().select().from(members).where(eq(members.id, id)))[0];

const audits = async () => db().select().from(auditEvents);

beforeEach(async () => {
  await env.DB.exec('DELETE FROM audit_events');
  await env.DB.exec('DELETE FROM members');
});

describe('creating a member', () => {
  it('derives the id from the name', async () => {
    const result = await createMember(db(), officer, { name: 'Daniel Doser', grade: 'Senior' });

    expect(result).toEqual({ ok: true, id: 'daniel-doser' });
    expect((await row('daniel-doser'))!.name).toBe('Daniel Doser');
  });

  it('always starts hidden, whatever the caller wants', async () => {
    await createMember(db(), officer, { name: 'New Student', grade: 'Freshman' });

    // Not an input on the type at all: whether a student's name and photo are
    // public is theirs to decide, not the person typing them in.
    expect((await row('new-student'))!.visibility).toBe(MEMBER_VISIBILITY.Limited);
  });

  it('starts active', async () => {
    await createMember(db(), officer, { name: 'New Student', grade: 'Freshman' });
    expect((await row('new-student'))!.isActive).toBe(true);
  });

  it('keeps an apostrophe out of the slug', async () => {
    const result = await createMember(db(), officer, { name: "Shea O'Brien", grade: 'Junior' });
    expect(result).toEqual({ ok: true, id: 'shea-obrien' });
  });

  it('collapses stray whitespace in the stored name', async () => {
    await createMember(db(), officer, { name: '  Ada   Lovelace  ', grade: 'Senior' });
    expect((await row('ada-lovelace'))!.name).toBe('Ada Lovelace');
  });

  it('records the creation, noting the member started hidden', async () => {
    await createMember(db(), officer, { name: 'Daniel Doser', grade: 'Senior' });

    const [audit] = await audits();
    expect(audit!.action).toBe(AUDIT_ACTION.MemberCreated);
    expect(audit!.actorUserId).toBe('user_officer');
    expect(audit!.payload).toMatchObject({
      name: 'Daniel Doser',
      grade: 'Senior',
      visibility: MEMBER_VISIBILITY.Limited,
    });
  });

  it('rejects a blank name', async () => {
    const result = await createMember(db(), officer, { name: '   ', grade: 'Senior' });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await db().select().from(members)).toHaveLength(0);
  });

  it('rejects a name that produces no usable slug', async () => {
    const result = await createMember(db(), officer, { name: '!!! ???', grade: 'Senior' });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('a name already on the roster', () => {
  beforeEach(async () => {
    await createMember(db(), officer, { name: 'Daniel Doser', grade: 'Senior' });
    await env.DB.exec('DELETE FROM audit_events');
  });

  it('stops and reports who already holds it', async () => {
    const result = await createMember(db(), officer, { name: 'Daniel Doser', grade: 'Freshman' });

    expect(result).toMatchObject({
      ok: false,
      reason: 'duplicate',
      existing: { id: 'daniel-doser', name: 'Daniel Doser', isActive: true },
      suggestedId: 'daniel-doser-2',
    });
  });

  it('writes nothing while the conflict is unresolved', async () => {
    await createMember(db(), officer, { name: 'Daniel Doser', grade: 'Freshman' });

    // The usual cause is re-adding somebody already there, so the default has
    // to be to create nothing rather than quietly make a second record.
    expect(await db().select().from(members)).toHaveLength(1);
    expect(await audits()).toHaveLength(0);
  });

  it('creates a suffixed record once the duplicate is confirmed', async () => {
    const result = await createMember(
      db(),
      officer,
      { name: 'Daniel Doser', grade: 'Freshman' },
      { allowDuplicateName: true },
    );

    expect(result).toEqual({ ok: true, id: 'daniel-doser-2' });
    expect(await db().select().from(members)).toHaveLength(2);
  });

  it('notes on the audit row which member the duplicate shadows', async () => {
    await createMember(
      db(),
      officer,
      { name: 'Daniel Doser', grade: 'Freshman' },
      { allowDuplicateName: true },
    );

    const [audit] = await audits();
    expect(audit!.payload).toMatchObject({ duplicateOf: 'daniel-doser' });
  });

  it('keeps counting up rather than reusing a taken suffix', async () => {
    const opts = { allowDuplicateName: true };
    await createMember(db(), officer, { name: 'Daniel Doser', grade: 'Freshman' }, opts);
    const third = await createMember(
      db(),
      officer,
      { name: 'Daniel Doser', grade: 'Sophomore' },
      opts,
    );

    expect(third).toEqual({ ok: true, id: 'daniel-doser-3' });
  });

  it('reports an inactive holder so they can be reactivated instead', async () => {
    await db()
      .update(members)
      .set({ isActive: false })
      .where(eq(members.id, 'daniel-doser'));

    const result = await createMember(db(), officer, { name: 'Daniel Doser', grade: 'Alumni' });
    expect(result).toMatchObject({ existing: { isActive: false } });
  });
});

describe('reactivating', () => {
  beforeEach(async () => {
    await createMember(db(), officer, { name: 'Daniel Doser', grade: 'Senior' });
    await db()
      .update(members)
      .set({ isActive: false })
      .where(eq(members.id, 'daniel-doser'));
    await env.DB.exec('DELETE FROM audit_events');
  });

  it('puts them back without a new id, so credits stay attached', async () => {
    expect((await reactivateMember(db(), officer, 'daniel-doser')).reactivated).toBe(true);

    expect((await row('daniel-doser'))!.isActive).toBe(true);
    expect(await db().select().from(members)).toHaveLength(1);
  });

  it('does not change their visibility', async () => {
    await reactivateMember(db(), officer, 'daniel-doser');
    expect((await row('daniel-doser'))!.visibility).toBe(MEMBER_VISIBILITY.Limited);
  });

  it('is audited as a change with a diff', async () => {
    await reactivateMember(db(), officer, 'daniel-doser');

    const [audit] = await audits();
    expect(audit!.action).toBe(AUDIT_ACTION.MemberUpdated);
    expect(audit!.diff).toEqual({ isActive: { before: false, after: true } });
  });

  it('does nothing to a member who is already active', async () => {
    await reactivateMember(db(), officer, 'daniel-doser');
    await env.DB.exec('DELETE FROM audit_events');

    expect((await reactivateMember(db(), officer, 'daniel-doser')).reactivated).toBe(false);
    expect(await audits()).toHaveLength(0);
  });

  it('ignores an unknown id', async () => {
    expect((await reactivateMember(db(), officer, 'nobody')).reactivated).toBe(false);
  });
});
