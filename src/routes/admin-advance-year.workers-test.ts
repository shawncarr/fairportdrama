import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import { members, MEMBER_VISIBILITY } from '~/db/schema/content';
import { APP_ROLE } from '~/db/schema/governance';
import { get, post, resetTables, signIn } from '~/test/session';

/**
 * The school-year rollover, from the admin.
 *
 * It rewrites every grade on the roster at once and has no undo, so the route
 * is gated harder than the rest of the member editing an officer can do.
 */

const db = () => getDb(env.DB);

const gradeOf = async (id: string) =>
  (await db().select().from(members).where(eq(members.id, id)))[0]!.grade;

const advanceForm = (year = 2026, acknowledged = true) => {
  const form = new FormData();
  form.set('schoolYear', String(year));
  if (acknowledged) form.set('acknowledged', 'on');
  return form;
};

beforeEach(async () => {
  await resetTables(['member_offices', 'member_roles', 'members']);
  await db().insert(members).values([
    { id: 'fresh-a', name: 'Ada Fresh', grade: 'Freshman', visibility: MEMBER_VISIBILITY.Full, isActive: true },
    { id: 'sen-b', name: 'Ben Senior', grade: 'Senior', visibility: MEMBER_VISIBILITY.Full, isActive: true },
  ]);
});

describe('who may advance the year', () => {
  it('lets an admin', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const response = await post('/admin/members/advance-year', cookie, advanceForm());

    expect(response.status).toBe(302);
    expect(await gradeOf('fresh-a')).toBe('Sophomore');
  });

  it('lets staff, who run the club day to day', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);

    await post('/admin/members/advance-year', cookie, advanceForm());
    expect(await gradeOf('fresh-a')).toBe('Sophomore');
  });

  it('refuses an officer, who may edit members but not graduate them', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);

    const response = await post('/admin/members/advance-year', cookie, advanceForm());

    expect(response.status).toBe(403);
    expect(await gradeOf('sen-b')).toBe('Senior');
  });

  it('refuses a plain member', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member);

    expect((await post('/admin/members/advance-year', cookie, advanceForm())).status).toBe(403);
    expect(await gradeOf('sen-b')).toBe('Senior');
  });

  it('does not offer the control to an officer', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);
    const body = await (await get('/admin/members', cookie)).text();

    expect(body).not.toContain('/admin/members/advance-year');
  });
});

describe('the confirmation', () => {
  it('is required by the server, not only marked required in the form', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    await post('/admin/members/advance-year', cookie, advanceForm(2026, false));

    expect(await gradeOf('fresh-a')).toBe('Freshman');
  });

  it('refuses a school year that is not a number', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const form = advanceForm();
    form.set('schoolYear', 'next');

    await post('/admin/members/advance-year', cookie, form);

    expect(await gradeOf('fresh-a')).toBe('Freshman');
  });

  it('shows what will change, and says the seniors leave', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const body = await (await get('/admin/members', cookie)).text();

    expect(body).toContain('/admin/members/advance-year');
    expect(body).toContain('Freshmen');
    expect(body).toContain('they leave the members page');
    expect(body).toContain('cannot be undone');
  });
});

describe('running it twice', () => {
  it('reports it already ran and changes nothing', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post('/admin/members/advance-year', cookie, advanceForm());

    const response = await post('/admin/members/advance-year', cookie, advanceForm());
    const location = response.headers.get('location')!;

    expect(decodeURIComponent(location)).toContain('already been advanced');
    // The double-click case: nobody should end up two grades on.
    expect(await gradeOf('fresh-a')).toBe('Sophomore');
  });

  it('surfaces that message on the page', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post('/admin/members/advance-year', cookie, advanceForm());
    await post('/admin/members/advance-year', cookie, advanceForm());

    const body = await (
      await get('/admin/members?advanceError=' + encodeURIComponent('Already advanced.'), cookie)
    ).text();
    expect(body).toContain('Already advanced.');
  });

  it('hides the control once nobody is left to advance', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await db().update(members).set({ grade: 'Alumni' });

    const body = await (await get('/admin/members', cookie)).text();
    expect(body).not.toContain('/admin/members/advance-year');
  });
});
