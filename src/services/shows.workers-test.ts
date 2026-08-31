import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { getDb, getShow } from '~/db/queries';
import { SHOW_COMPANY, showCast, showPerformances, shows } from '~/db/schema/content';
import { auditEvents } from '~/db/schema/governance';
import { AUDIT_ACTOR_KIND, type Actor } from '~/lib/audit/actor';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import {
  createShow,
  deleteShow,
  replacePerformances,
  setAnnounced,
  updateShow,
} from './shows';

const db = () => getDb(env.DB);

const staff: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'user_staff',
  label: 'Director',
  ip: '203.0.113.60',
  userAgent: 'Firefox',
};

const audits = async () => db().select().from(auditEvents);

const input = {
  title: 'Into the Woods',
  season: 'Fall 2026',
  year: 2026,
  venue: '',
  synopsis: 'Fairy tales collide.',
  ticketUrl: null,
  isHighlighted: false,
  company: null,
};

const dates = (showId: string) =>
  db()
    .select()
    .from(showPerformances)
    .where(eq(showPerformances.showId, showId))
    .orderBy(asc(showPerformances.date));

beforeEach(async () => {
  await env.DB.exec('DELETE FROM audit_events');
  await env.DB.exec('DELETE FROM show_gallery_images');
  await env.DB.exec('DELETE FROM show_cast');
  await env.DB.exec('DELETE FROM show_crew');
  await env.DB.exec('DELETE FROM show_performances');
  await env.DB.exec('DELETE FROM shows');
});

describe('creating a show', () => {
  it('builds the id from title and year, matching the migrated ones', async () => {
    expect(await createShow(db(), staff, input)).toEqual({
      ok: true,
      id: 'into-the-woods-2026',
    });
  });

  it('stores the company that staged it', async () => {
    await createShow(db(), staff, { ...input, company: SHOW_COMPANY.Jv });
    const [row] = await db().select().from(shows);

    expect(row!.company).toBe('jv');
  });

  it('leaves the company null for a show the whole club stages', async () => {
    await createShow(db(), staff, input);
    const [row] = await db().select().from(shows);

    expect(row!.company).toBeNull();
  });

  it('does not announce it, so creating and announcing stay separate', async () => {
    const created = await createShow(db(), staff, input);
    const [row] = await db().select().from(shows);

    expect(row!.isAnnounced).toBe(false);
    expect(created.ok).toBe(true);
  });

  it('falls back to the usual venue when none is given', async () => {
    await createShow(db(), staff, input);
    const [row] = await db().select().from(shows);
    expect(row!.venue).toBe('Fairport High School Auditorium');
  });

  it('suffixes a restaging in the same year rather than colliding', async () => {
    await createShow(db(), staff, input);
    expect(await createShow(db(), staff, input)).toEqual({
      ok: true,
      id: 'into-the-woods-2026-2',
    });
  });

  it('rejects a blank title without writing anything', async () => {
    expect(await createShow(db(), staff, { ...input, title: '  ' })).toMatchObject({
      ok: false,
    });
    expect(await db().select().from(shows)).toHaveLength(0);
  });

  it('is audited', async () => {
    await createShow(db(), staff, input);
    const [audit] = await audits();
    expect(audit!.action).toBe(AUDIT_ACTION.ShowCreated);
    expect(audit!.payload).toMatchObject({ title: 'Into the Woods', year: 2026 });
  });
});

describe('editing a show', () => {
  beforeEach(async () => {
    await createShow(db(), staff, input);
    await env.DB.exec('DELETE FROM audit_events');
  });

  it('keeps the id when the title changes', async () => {
    await updateShow(db(), staff, 'into-the-woods-2026', { title: 'Into The Woods Jr.' });

    const [row] = await db().select().from(shows);
    expect(row!.title).toBe('Into The Woods Jr.');
    // The id is the public URL of a show that may already be selling tickets.
    expect(row!.id).toBe('into-the-woods-2026');
  });

  it('writes nothing when a resubmitted form changes nothing', async () => {
    await updateShow(db(), staff, 'into-the-woods-2026', {
      title: 'Into the Woods',
      season: 'Fall 2026',
    });
    expect(await audits()).toHaveLength(0);
  });

  it('ignores an unknown show', async () => {
    expect((await updateShow(db(), staff, 'nope', { title: 'x' })).updated).toBe(false);
  });
});

describe('announcing a show', () => {
  beforeEach(async () => {
    await createShow(db(), staff, input);
    await createShow(db(), staff, { ...input, title: 'Matilda', year: 2027 });
    // A third show nobody announces. Without a row that must stay false, a
    // write that announced every row would satisfy every assertion here.
    await createShow(db(), staff, { ...input, title: 'Bystander', year: 2028 });
    await env.DB.exec('DELETE FROM audit_events');
  });

  it('leaves the first show announced when a second is announced', async () => {
    await setAnnounced(db(), staff, 'into-the-woods-2026', true);
    await setAnnounced(db(), staff, 'matilda-2027', true);

    const rows = await db().select().from(shows);
    expect(rows.filter((s) => s.isAnnounced).map((s) => s.id).sort()).toEqual([
      'into-the-woods-2026',
      'matilda-2027',
    ]);
    expect(rows.find((s) => s.id === 'bystander-2028')!.isAnnounced).toBe(false);
  });

  it('un-announces one show without touching the others', async () => {
    await setAnnounced(db(), staff, 'into-the-woods-2026', true);
    await setAnnounced(db(), staff, 'matilda-2027', true);
    await setAnnounced(db(), staff, 'matilda-2027', false);

    const announced = (await db().select().from(shows)).filter((s) => s.isAnnounced);
    expect(announced.map((s) => s.id)).toEqual(['into-the-woods-2026']);
  });

  it('records the announcement as a diff on the show itself', async () => {
    await env.DB.exec('DELETE FROM audit_events');
    await setAnnounced(db(), staff, 'into-the-woods-2026', true);

    const [audit] = await audits();
    expect(audit!.diff).toEqual({ isAnnounced: { before: false, after: true } });
    expect(audit!.targetId).toBe('into-the-woods-2026');
    // Without these an announcement could file itself as, say, a deleted
    // news item and the suite would not notice. The audit log is the record.
    expect(audit!.action).toBe(AUDIT_ACTION.ShowUpdated);
    expect(audit!.targetKind).toBe(AUDIT_ENTITY_KIND.Show);
  });

  it('ignores an unknown show rather than throwing at the route', async () => {
    expect(await setAnnounced(db(), staff, 'nope', true)).toEqual({ changed: false });
    expect(await audits()).toHaveLength(0);
  });

  it('stamps updatedAt so an announcement is not an invisible edit', async () => {
    const before = (await db().select().from(shows)).find(
      (r) => r.id === 'into-the-woods-2026',
    )!.updatedAt;
    await new Promise((r) => setTimeout(r, 1100));
    await setAnnounced(db(), staff, 'into-the-woods-2026', true);

    const after = (await db().select().from(shows)).find(
      (r) => r.id === 'into-the-woods-2026',
    )!.updatedAt;
    expect(after > before).toBe(true);
  });

  it('does nothing when the show is already in that state', async () => {
    await setAnnounced(db(), staff, 'into-the-woods-2026', true);
    await env.DB.exec('DELETE FROM audit_events');

    expect(await setAnnounced(db(), staff, 'into-the-woods-2026', true)).toEqual({
      changed: false,
    });
    expect(await audits()).toHaveLength(0);
  });
});

describe('performance dates', () => {
  beforeEach(async () => {
    await createShow(db(), staff, input);
    await env.DB.exec('DELETE FROM audit_events');
  });

  it('saves and sorts them', async () => {
    await replacePerformances(db(), staff, 'into-the-woods-2026', [
      { date: '2026-11-14', time: '7:30 PM' },
      { date: '2026-11-13', time: '7:30 PM' },
    ]);

    expect((await dates('into-the-woods-2026')).map((p) => p.date)).toEqual([
      '2026-11-13',
      '2026-11-14',
    ]);
  });

  it('drops rows with no date, so blank form rows are not stored', async () => {
    await replacePerformances(db(), staff, 'into-the-woods-2026', [
      { date: '2026-11-13', time: '7:30 PM' },
      { date: '', time: '' },
      { date: 'not-a-date', time: '2:00 PM' },
    ]);

    expect(await dates('into-the-woods-2026')).toHaveLength(1);
  });

  it('keeps a time-less date, since the time is often decided later', async () => {
    await replacePerformances(db(), staff, 'into-the-woods-2026', [
      { date: '2026-11-13', time: '' },
    ]);
    expect(await dates('into-the-woods-2026')).toHaveLength(1);
  });

  it('replaces the whole schedule rather than appending', async () => {
    const id = 'into-the-woods-2026';
    await replacePerformances(db(), staff, id, [{ date: '2026-11-13', time: '7:30 PM' }]);
    await replacePerformances(db(), staff, id, [{ date: '2026-11-20', time: '7:30 PM' }]);

    expect((await dates(id)).map((p) => p.date)).toEqual(['2026-11-20']);
  });

  it('writes nothing when the schedule is unchanged', async () => {
    const id = 'into-the-woods-2026';
    const rows = [{ date: '2026-11-13', time: '7:30 PM' }];
    await replacePerformances(db(), staff, id, rows);
    await env.DB.exec('DELETE FROM audit_events');

    expect((await replacePerformances(db(), staff, id, rows)).changed).toBe(false);
    expect(await audits()).toHaveLength(0);
  });

  it('decides whether the run reads as over', async () => {
    const id = 'into-the-woods-2026';
    await setAnnounced(db(), staff, id, true);

    await replacePerformances(db(), staff, id, [{ date: '2020-01-01', time: '7:30 PM' }]);
    expect((await getShow(db(), id))!.closed).toBe(true);

    await replacePerformances(db(), staff, id, [{ date: '2099-01-01', time: '7:30 PM' }]);
    expect((await getShow(db(), id))!.closed).toBe(false);
  });
});

describe('deleting a show', () => {
  beforeEach(async () => {
    await createShow(db(), staff, input);
    await env.DB.exec('DELETE FROM audit_events');
  });

  it('removes one with nothing recorded against it', async () => {
    await replacePerformances(db(), staff, 'into-the-woods-2026', [
      { date: '2026-11-13', time: '7:30 PM' },
    ]);

    expect(await deleteShow(db(), staff, 'into-the-woods-2026')).toEqual({ ok: true });
    expect(await db().select().from(shows)).toHaveLength(0);
    // Performances go with it; they describe nobody.
    expect(await db().select().from(showPerformances)).toHaveLength(0);
  });

  it('refuses once a cast exists, so history cannot be erased', async () => {
    await db().insert(showCast).values({
      id: 'c1',
      showId: 'into-the-woods-2026',
      memberId: null,
      role: 'Baker',
      tier: 'lead',
      sortOrder: 0,
    });

    const result = await deleteShow(db(), staff, 'into-the-woods-2026');
    expect(result).toMatchObject({ ok: false });
    expect(await db().select().from(shows)).toHaveLength(1);
  });

  it('keeps the title on the audit row', async () => {
    await deleteShow(db(), staff, 'into-the-woods-2026');
    const [audit] = await audits();
    expect(audit!.action).toBe(AUDIT_ACTION.ShowDeleted);
    expect(audit!.payload).toMatchObject({ title: 'Into the Woods' });
  });

  it('refuses an unknown show', async () => {
    expect(await deleteShow(db(), staff, 'nope')).toMatchObject({ ok: false });
  });
});
