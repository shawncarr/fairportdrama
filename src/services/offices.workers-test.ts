import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getActiveMembers, getDb, getPublicMemberProfile, formatTerm } from '~/db/queries';
import { memberOffices, members, MEMBER_VISIBILITY } from '~/db/schema/content';
import { auditEvents } from '~/db/schema/governance';
import { AUDIT_ACTOR_KIND, type Actor } from '~/lib/audit/actor';
import { AUDIT_ACTION } from '~/lib/audit/constants';
import { addOffice, deleteOffice, endOffice, getOffices } from '~/services/members';

/**
 * Terms of office.
 *
 * The point of the table is that a term outlives the person holding it: a
 * student who was Treasurer keeps that on their profile afterwards. The flag
 * it replaced could only ever say "now", so a board turnover erased the whole
 * history - and six of the seven officers on the roster were Seniors.
 */

const db = () => getDb(env.DB);

const board: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'u_board',
  label: 'Board Member',
  ip: '203.0.113.80',
  userAgent: 'Firefox',
};

const audits = async () => db().select().from(auditEvents);

beforeEach(async () => {
  await env.DB.exec('DELETE FROM audit_events');
  await env.DB.exec('DELETE FROM member_offices');
  await env.DB.exec('DELETE FROM members');

  await db().insert(members).values([
    {
      id: 'ari-toner',
      name: 'Ariana Toner',
      grade: 'Senior',
      visibility: MEMBER_VISIBILITY.Full,
      isActive: true,
    },
    {
      id: 'hidden-harriet',
      name: 'Harriet Hidden',
      grade: 'Junior',
      visibility: MEMBER_VISIBILITY.Limited,
      isActive: true,
    },
  ]);
});

describe('recording a term', () => {
  it('stores it and audits who did it', async () => {
    const result = await addOffice(db(), board, 'ari-toner', {
      title: 'Treasurer',
      startYear: 2025,
    });
    expect(result).toMatchObject({ ok: true });

    const [office] = await getOffices(db(), 'ari-toner');
    expect(office!.title).toBe('Treasurer');
    expect(office!.startYear).toBe(2025);
    expect(office!.endYear).toBeNull();

    const [audit] = await audits();
    expect(audit!.action).toBe(AUDIT_ACTION.MemberOfficeChanged);
    expect(audit!.payload).toMatchObject({ added: true, title: 'Treasurer' });
  });

  it('refuses a blank title and an unknown member', async () => {
    expect(await addOffice(db(), board, 'ari-toner', { title: '  ', startYear: 2025 }))
      .toMatchObject({ ok: false });
    expect(await addOffice(db(), board, 'nobody', { title: 'President', startYear: 2025 }))
      .toMatchObject({ ok: false });
    expect(await audits()).toHaveLength(0);
  });

  it('refuses a term that ends before it starts', async () => {
    const result = await addOffice(db(), board, 'ari-toner', {
      title: 'Treasurer',
      startYear: 2025,
      endYear: 2024,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it('allows several terms, including the same office twice', async () => {
    await addOffice(db(), board, 'ari-toner', { title: 'Secretary', startYear: 2024, endYear: 2025 });
    await addOffice(db(), board, 'ari-toner', { title: 'Treasurer', startYear: 2025 });

    expect(await getOffices(db(), 'ari-toner')).toHaveLength(2);
  });
});

describe('current officer status is derived', () => {
  it('an open term makes them current, a closed one does not', async () => {
    await addOffice(db(), board, 'ari-toner', { title: 'Treasurer', startYear: 2025 });

    let listed = (await getActiveMembers(db())).find((m) => m.id === 'ari-toner')!;
    expect(listed.isOfficer).toBe(true);
    expect(listed.officerTitle).toBe('Treasurer');

    const [office] = await getOffices(db(), 'ari-toner');
    await endOffice(db(), board, office!.id, 2026);

    // Nothing else had to be updated. There is no flag to fall out of step.
    listed = (await getActiveMembers(db())).find((m) => m.id === 'ari-toner')!;
    expect(listed.isOfficer).toBe(false);
    expect(listed.officerTitle).toBeNull();
  });

  it('keeps the finished term on the record', async () => {
    await addOffice(db(), board, 'ari-toner', { title: 'Treasurer', startYear: 2025 });
    const [office] = await getOffices(db(), 'ari-toner');
    await endOffice(db(), board, office!.id, 2026);

    const profile = await getPublicMemberProfile(db(), 'ari-toner');
    expect(profile!.offices).toHaveLength(1);
    expect(profile!.offices[0]).toMatchObject({
      title: 'Treasurer',
      term: '2025–2026',
      isCurrent: false,
    });
  });

  it('lists terms newest first', async () => {
    await addOffice(db(), board, 'ari-toner', { title: 'Secretary', startYear: 2024, endYear: 2025 });
    await addOffice(db(), board, 'ari-toner', { title: 'Treasurer', startYear: 2025 });

    const profile = await getPublicMemberProfile(db(), 'ari-toner');
    expect(profile!.offices.map((o) => o.title)).toEqual(['Treasurer', 'Secretary']);
  });
});

describe('ending a term', () => {
  it('records the change with both values', async () => {
    await addOffice(db(), board, 'ari-toner', { title: 'Treasurer', startYear: 2025 });
    await env.DB.exec('DELETE FROM audit_events');
    const [office] = await getOffices(db(), 'ari-toner');

    expect((await endOffice(db(), board, office!.id, 2026)).ended).toBe(true);

    const [audit] = await audits();
    expect(audit!.diff).toEqual({ endYear: { before: null, after: 2026 } });
  });

  it('cannot end one twice, or end it before it began', async () => {
    await addOffice(db(), board, 'ari-toner', { title: 'Treasurer', startYear: 2025 });
    const [office] = await getOffices(db(), 'ari-toner');

    expect((await endOffice(db(), board, office!.id, 2024)).ended).toBe(false);
    expect((await endOffice(db(), board, office!.id, 2026)).ended).toBe(true);
    expect((await endOffice(db(), board, office!.id, 2027)).ended).toBe(false);
  });

  it('ignores an unknown office', async () => {
    expect((await endOffice(db(), board, 'nope', 2026)).ended).toBe(false);
  });
});

describe('removing a term', () => {
  it('keeps the title on the audit row', async () => {
    await addOffice(db(), board, 'ari-toner', { title: 'Treasurer', startYear: 2025 });
    await env.DB.exec('DELETE FROM audit_events');
    const [office] = await getOffices(db(), 'ari-toner');

    expect((await deleteOffice(db(), board, office!.id)).deleted).toBe(true);
    expect(await getOffices(db(), 'ari-toner')).toHaveLength(0);

    // "Who removed my term as Treasurer" cannot be answered by joining against
    // a row that no longer exists.
    const [audit] = await audits();
    expect(audit!.payload).toMatchObject({ deleted: true, title: 'Treasurer' });
  });

  it('ignores an unknown office', async () => {
    expect((await deleteOffice(db(), board, 'nope')).deleted).toBe(false);
  });
});

describe('offices and privacy', () => {
  it('a hidden officer is still reduced to first name and last initial', async () => {
    await addOffice(db(), board, 'hidden-harriet', { title: 'President', startYear: 2025 });

    const listed = (await getActiveMembers(db())).find((m) => m.id === 'hidden-harriet')!;
    expect(listed.isOfficer).toBe(true);
    expect(listed.name).toBe('Harriet H.');
    // Holding an office does not create a page for somebody who opted out.
    expect(listed.href).toBeNull();
    expect(await getPublicMemberProfile(db(), 'hidden-harriet')).toBeNull();
  });
});

describe('deleting a member', () => {
  it('takes their offices with them', async () => {
    await addOffice(db(), board, 'ari-toner', { title: 'Treasurer', startYear: 2025 });
    await db().delete(members).where(eq(members.id, 'ari-toner'));

    expect(await db().select().from(memberOffices)).toHaveLength(0);
  });
});

describe('formatTerm', () => {
  it('renders a completed and an open term', () => {
    expect(formatTerm(2025, 2026)).toBe('2025–2026');
    expect(formatTerm(2025, null)).toBe('2025–present');
  });
});
