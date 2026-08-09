import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import { members, MEMBER_VISIBILITY } from '~/db/schema/content';
import { auditEvents } from '~/db/schema/governance';
import { AUDIT_ACTOR_KIND, type Actor } from '~/lib/audit/actor';
import { AUDIT_ACTION } from '~/lib/audit/constants';
import { advanceGrades, previewAdvanceGrades } from './members';

/**
 * The school-year rollover.
 *
 * `members.grade` describes the present and so goes stale by itself every
 * June. This is the one action that moves it, which makes running it twice the
 * failure that matters: there is no undo, and a second pass would put this
 * year's freshmen into junior year.
 */

const db = () => getDb(env.DB);

const board: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'u_board',
  label: 'Board Member',
  ip: '203.0.113.90',
  userAgent: 'Firefox',
};

const ROSTER = [
  { id: 'fresh-fiona', name: 'Fiona Fresh', grade: 'Freshman' },
  { id: 'soph-sam', name: 'Sam Soph', grade: 'Sophomore' },
  { id: 'jun-jo', name: 'Jo Junior', grade: 'Junior' },
  { id: 'sen-sara', name: 'Sara Senior', grade: 'Senior' },
  { id: 'alum-al', name: 'Al Alum', grade: 'Alumni' },
  { id: 'fac-fay', name: 'Fay Faculty', grade: 'Faculty' },
];

const gradeOf = async (id: string) =>
  (await db().select().from(members).where(eq(members.id, id)))[0]!.grade;

const audits = async () => db().select().from(auditEvents).orderBy(asc(auditEvents.targetId));

beforeEach(async () => {
  await env.DB.exec('DELETE FROM audit_events');
  await env.DB.exec('DELETE FROM members');
  await db()
    .insert(members)
    .values(
      ROSTER.map((m) => ({
        ...m,
        visibility: MEMBER_VISIBILITY.Full,
        isActive: true,
      })),
    );
});

describe('advancing the school year', () => {
  it('moves every student up one and graduates the seniors', async () => {
    const result = await advanceGrades(db(), board, 2026);

    expect(result).toMatchObject({ ok: true, advanced: 4, graduated: 1 });
    expect(await gradeOf('fresh-fiona')).toBe('Sophomore');
    expect(await gradeOf('soph-sam')).toBe('Junior');
    expect(await gradeOf('jun-jo')).toBe('Senior');
    expect(await gradeOf('sen-sara')).toBe('Alumni');
  });

  it('leaves alumni and faculty alone', async () => {
    await advanceGrades(db(), board, 2026);

    expect(await gradeOf('alum-al')).toBe('Alumni');
    expect(await gradeOf('fac-fay')).toBe('Faculty');
  });

  it('skips inactive members, who are not on this year of the roster', async () => {
    await db().update(members).set({ isActive: false }).where(eq(members.id, 'fresh-fiona'));

    const result = await advanceGrades(db(), board, 2026);

    expect(result).toMatchObject({ advanced: 3 });
    expect(await gradeOf('fresh-fiona')).toBe('Freshman');
  });

  it('records one audit row per member, with the before and after grade', async () => {
    await advanceGrades(db(), board, 2026);
    const rows = await audits();

    // A single "someone advanced the year" row could not answer "why does my
    // profile say Alumni", which is the question this gets asked.
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.action === AUDIT_ACTION.MemberGradeAdvanced)).toBe(true);
    expect(rows.every((r) => r.actorUserId === 'u_board')).toBe(true);

    const sara = rows.find((r) => r.targetId === 'sen-sara')!;
    expect(sara.diff).toEqual({ grade: { before: 'Senior', after: 'Alumni' } });
    expect(sara.payload).toMatchObject({ schoolYear: 2026 });
  });

  it('writes no row for the members it did not touch', async () => {
    await advanceGrades(db(), board, 2026);
    const ids = (await audits()).map((r) => r.targetId);

    expect(ids).not.toContain('alum-al');
    expect(ids).not.toContain('fac-fay');
  });
});

describe('running it twice', () => {
  it('refuses the second run for the same year and changes nothing', async () => {
    await advanceGrades(db(), board, 2026);

    const second = await advanceGrades(db(), board, 2026);

    expect(second).toEqual({ ok: false, reason: 'already-run' });
    // The failure this guards against: a freshman two years on in one August.
    expect(await gradeOf('fresh-fiona')).toBe('Sophomore');
    expect(await audits()).toHaveLength(4);
  });

  it('allows the next year, which is a different rollover', async () => {
    await advanceGrades(db(), board, 2026);

    // Three, not four: last year's senior is already an alum and stays put.
    expect(await advanceGrades(db(), board, 2027)).toMatchObject({
      ok: true,
      advanced: 3,
      graduated: 1,
    });
    expect(await gradeOf('fresh-fiona')).toBe('Junior');
    expect(await gradeOf('sen-sara')).toBe('Alumni');
  });

  it('is not blocked by an ordinary edit to the same member', async () => {
    // The guard keys on the rollover action, not on any change to a grade, so
    // fixing one student's grade by hand cannot lock out the year.
    await db().update(members).set({ grade: 'Junior' }).where(eq(members.id, 'soph-sam'));

    expect(await advanceGrades(db(), board, 2026)).toMatchObject({ ok: true });
  });
});

describe('previewing the rollover', () => {
  it('reports what each grade becomes and how many move', async () => {
    const preview = await previewAdvanceGrades(db());

    expect(preview.total).toBe(4);
    expect(preview.graduating).toBe(1);
    expect(preview.counts).toEqual([
      { grade: 'Freshman', next: 'Sophomore', count: 1 },
      { grade: 'Sophomore', next: 'Junior', count: 1 },
      { grade: 'Junior', next: 'Senior', count: 1 },
      { grade: 'Senior', next: 'Alumni', count: 1 },
    ]);
  });

  it('omits a grade nobody is in, so the confirmation reads honestly', async () => {
    await db().delete(members).where(eq(members.id, 'jun-jo'));

    const preview = await previewAdvanceGrades(db());
    expect(preview.counts.map((r) => r.grade)).toEqual(['Freshman', 'Sophomore', 'Senior']);
  });

  it('changes nothing', async () => {
    await previewAdvanceGrades(db());

    expect(await gradeOf('sen-sara')).toBe('Senior');
    expect(await audits()).toHaveLength(0);
  });

  it('matches what the rollover then does', async () => {
    const preview = await previewAdvanceGrades(db());
    const result = await advanceGrades(db(), board, 2026);

    expect(result).toMatchObject({ advanced: preview.total, graduated: preview.graduating });
  });
});
