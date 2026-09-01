import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import { showCast, showPerformances, shows } from '~/db/schema/content';
import { APP_ROLE } from '~/db/schema/governance';
import { get, post, resetTables, signIn } from '~/test/session';

const db = () => getDb(env.DB);

const showForm = (over: Record<string, string> = {}) => {
  const form = new FormData();
  form.set('title', 'Into the Woods');
  form.set('season', 'Fall 2026');
  form.set('year', '2026');
  form.set('venue', '');
  form.set('synopsis', 'Fairy tales collide.');
  form.set('ticketUrl', '');
  for (const [k, v] of Object.entries(over)) form.set(k, v);
  return form;
};

const all = () => db().select().from(shows);

beforeEach(async () => {
  await resetTables([
    'show_cast',
    'show_crew',
    'show_gallery_images',
    'show_performances',
    'shows',
    'members',
  ]);
});

describe('creating a show', () => {
  it('works for staff and lands on the new show', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);

    const response = await post('/admin/shows/new', cookie, showForm());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/shows/into-the-woods-2026');
    expect(await all()).toHaveLength(1);
  });

  it('rejects a year that is not a year', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);
    const response = await post('/admin/shows/new', cookie, showForm({ year: 'soon' }));

    expect(response.headers.get('location')).toContain('error=');
    expect(await all()).toHaveLength(0);
  });

  it('is refused to an officer, who casts shows but does not announce them', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);

    expect((await get('/admin/shows/new', cookie)).status).toBe(403);
    expect((await post('/admin/shows/new', cookie, showForm())).status).toBe(403);
    expect(await all()).toHaveLength(0);
  });

  it('is not offered to an officer on the shows list', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);
    const body = await (await get('/admin/shows', cookie)).text();
    expect(body).not.toContain('href="/admin/shows/new"');
  });

  it('is offered to staff', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);
    const body = await (await get('/admin/shows', cookie)).text();
    expect(body).toContain('href="/admin/shows/new"');
  });
});

describe('the show page', () => {
  const setup = async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);
    await post('/admin/shows/new', cookie, showForm());
    return cookie;
  };

  it('saves details without changing the id', async () => {
    const cookie = await setup();
    await post(
      '/admin/shows/into-the-woods-2026/details',
      cookie,
      showForm({ title: 'Into The Woods Jr.', ticketUrl: 'https://tickets.example.com' }),
    );

    const [row] = await all();
    expect(row!.title).toBe('Into The Woods Jr.');
    expect(row!.ticketUrl).toBe('https://tickets.example.com');
    expect(row!.id).toBe('into-the-woods-2026');
  });

  it('saves performance dates and skips blank rows', async () => {
    const cookie = await setup();

    const form = new FormData();
    form.append('date', '2026-11-13');
    form.append('time', '7:30 PM');
    form.append('date', '2026-11-14');
    form.append('time', '2:00 PM');
    form.append('date', '');
    form.append('time', '');
    await post('/admin/shows/into-the-woods-2026/performances', cookie, form);

    expect(await db().select().from(showPerformances)).toHaveLength(2);
  });

  const announce = (v: string) => {
    const f = new FormData();
    f.set('announced', v);
    return f;
  };

  it('announces and un-announces the show', async () => {
    const cookie = await setup();

    await post('/admin/shows/into-the-woods-2026/announce', cookie, announce('1'));
    expect((await all())[0]!.isAnnounced).toBe(true);

    await post('/admin/shows/into-the-woods-2026/announce', cookie, announce('0'));
    expect((await all())[0]!.isAnnounced).toBe(false);
  });

  it('announces a show without disturbing another already announced', async () => {
    const cookie = await setup();
    await db().insert(shows).values({
      id: 'matilda-2027',
      title: 'Matilda',
      season: 'Spring 2027',
      year: 2027,
      synopsis: 'A second production.',
    });

    await post('/admin/shows/into-the-woods-2026/announce', cookie, announce('1'));
    await post('/admin/shows/matilda-2027/announce', cookie, announce('1'));

    const announced = (await all()).filter((s) => s.isAnnounced);
    expect(announced.map((s) => s.id).sort()).toEqual([
      'into-the-woods-2026',
      'matilda-2027',
    ]);
  });

  it('stores the company chosen on the form', async () => {
    const cookie = await setup();
    await post(
      '/admin/shows/new',
      cookie,
      showForm({ title: 'Company Test', year: '2027', company: 'jv' }),
    );

    const [row] = await db().select().from(shows).where(eq(shows.id, 'company-test-2027'));
    expect(row!.company).toBe('jv');
  });

  it('rejects a company the form could not have offered', async () => {
    const cookie = await setup();
    await post(
      '/admin/shows/new',
      cookie,
      showForm({ title: 'Forged', year: '2027', company: 'not-a-company' }),
    );

    // isShowCompany guards the boundary. A bare cast would store this, and
    // the badge would then render as an empty pill - `show.company &&` passes
    // on any truthy string while the label lookup returns undefined.
    const [row] = await db().select().from(shows).where(eq(shows.id, 'forged-2027'));
    expect(row!.company).toBeNull();
  });

  it('hides the details and dates forms from an officer', async () => {
    await setup();
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);
    const body = await (await get('/admin/shows/into-the-woods-2026', cookie)).text();

    // The page is reachable with cast.assign, so the editable parts must be
    // withheld rather than shown and then refused on submit.
    expect(body).toContain('Cast');
    expect(body).not.toContain('/details');
    expect(body).not.toContain('/performances');
    expect(body).not.toContain('/announce');
  });

  it('refuses an officer the write routes too', async () => {
    await setup();
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);

    expect(
      (await post('/admin/shows/into-the-woods-2026/details', cookie, showForm())).status,
    ).toBe(403);
    expect(
      (await post('/admin/shows/into-the-woods-2026/announce', cookie, new FormData())).status,
    ).toBe(403);
  });
});

describe('deleting a show', () => {
  it('works while nothing is recorded against it', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post('/admin/shows/new', cookie, showForm());

    const response = await post(
      '/admin/shows/into-the-woods-2026/delete',
      cookie,
      new FormData(),
    );
    expect(response.headers.get('location')).toBe('/admin/shows');
    expect(await all()).toHaveLength(0);
  });

  it('refuses once a cast exists and says why', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post('/admin/shows/new', cookie, showForm());
    await db().insert(showCast).values({
      id: 'c1',
      showId: 'into-the-woods-2026',
      memberId: null,
      role: 'Baker',
      tier: 'lead',
      sortOrder: 0,
    });

    const response = await post(
      '/admin/shows/into-the-woods-2026/delete',
      cookie,
      new FormData(),
    );
    expect(response.headers.get('location')).toContain('error=');
    expect(await all()).toHaveLength(1);
  });

  it('is allowed to staff, who hold show.delete alongside admin', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);
    await post('/admin/shows/new', cookie, showForm());

    await post('/admin/shows/into-the-woods-2026/delete', cookie, new FormData());
    expect(await all()).toHaveLength(0);
  });

  it('is refused to an officer', async () => {
    const staffCookie = await signIn('director@example.com', APP_ROLE.Staff);
    await post('/admin/shows/new', staffCookie, showForm());

    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);
    expect(
      (await post('/admin/shows/into-the-woods-2026/delete', cookie, new FormData())).status,
    ).toBe(403);
    expect(await all()).toHaveLength(1);
  });
});
