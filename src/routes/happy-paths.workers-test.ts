import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import {
  members,
  news,
  showCast,
  showPerformances,
  shows,
  MEMBER_VISIBILITY,
} from '~/db/schema/content';
import { APP_ROLE } from '~/db/schema/governance';
import { newsletterSubscribers } from '~/db/schema/newsletter';
import { AUDIT_ACTOR_KIND, type Actor } from '~/lib/audit/actor';
import { replacePerformances } from '~/services/shows';
import { get, post, resetTables, signIn } from '~/test/session';

/**
 * The successful branches that the rest of the suite stepped over.
 *
 * Coverage was concentrated on writes and on refusals, which left a set of
 * paths that only appear when something works: a redirect that lands on a
 * show, a section that only renders when there is content for it, a status
 * badge, a plural.
 */

const db = () => getDb(env.DB);

const staff: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'u_staff',
  label: 'Director',
  ip: '203.0.113.5',
  userAgent: 'Firefox',
};

const FAR_FUTURE = '2099-05-01';

beforeEach(async () => {
  await resetTables([
    'show_cast',
    'show_crew',
    'show_gallery_images',
    'show_performances',
    'shows',
    'news',
    'members',
  ]);
  await env.DB.exec('DELETE FROM newsletter_subscribers');
});

const seedRunningShow = async () => {
  await db().insert(shows).values({
    id: 'lightning-thief',
    title: 'The Lightning Thief',
    season: 'Spring 2026',
    year: 2026,
    synopsis: 'A demigod quest.',
    ticketUrl: 'https://tickets.example.com',
    isAnnounced: true,
  });
  await db().insert(showPerformances).values({
    id: 'p1',
    showId: 'lightning-thief',
    date: FAR_FUTURE,
    time: '7:30 PM',
  });
};

describe('/shows/current', () => {
  it('redirects to the featured show when there is one', async () => {
    await seedRunningShow();

    const res = await get('/shows/current');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/shows/lightning-thief');
  });

  it('falls back to the index when nothing is upcoming', async () => {
    const res = await get('/shows/current');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/shows');
  });
});

describe('sections that only appear when there is content', () => {
  it('the home page carries the news section once posts exist', async () => {
    await seedRunningShow();
    expect(await (await get('/')).text()).not.toContain('Latest News');

    await db().insert(news).values({
      id: 'auditions-open',
      title: 'Auditions Open',
      excerpt: 'Come try out.',
      bodyMd: 'x',
      publishedAt: '2026-01-05',
      category: 'auditions',
      isDraft: false,
    });

    const withNews = await (await get('/')).text();
    expect(withNews).toContain('Auditions Open');
  });

  it('a member profile lists the productions they appeared in', async () => {
    await db().insert(members).values({
      id: 'daniel-doser',
      name: 'Daniel Doser',
      grade: 'Senior',
      visibility: MEMBER_VISIBILITY.Full,
      isActive: true,
    });

    // Before any casting, the profile has no productions section.
    expect(await (await get('/members/daniel-doser')).text()).not.toContain('Productions');

    await seedRunningShow();
    await db().insert(showCast).values({
      id: 'c1',
      showId: 'lightning-thief',
      memberId: 'daniel-doser',
      role: 'Percy Jackson',
      tier: 'lead',
      sortOrder: 0,
    });

    const withCredits = await (await get('/members/daniel-doser')).text();
    expect(withCredits).toContain('Productions');
    expect(withCredits).toContain('The Lightning Thief');
    expect(withCredits).toContain('Spring 2026');
  });
});

describe('the admin shows list', () => {
  // The badge is read out of its own <tr>: the status words also appear in
  // the page chrome and in other rows, so a bare toContain proves nothing.
  const row = (html: string, title: string) => {
    const at = html.indexOf(title);
    expect(at, `${title} is not in the list`).toBeGreaterThan(-1);
    return html.slice(at, html.indexOf('</tr>', at));
  };

  it('marks an announced show whose run is still ahead as upcoming', async () => {
    await seedRunningShow();
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const html = await (await get('/admin/shows', cookie)).text();
    expect(row(html, 'The Lightning Thief')).toContain('>Upcoming<');
  });

  it('marks an unannounced production that has not run as a draft', async () => {
    await db().insert(shows).values({
      id: 'old-show',
      title: 'Old Show',
      season: 'Fall 2024',
      year: 2024,
      synopsis: 'Done.',
      isAnnounced: false,
    });
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const html = await (await get('/admin/shows', cookie)).text();
    expect(row(html, 'Old Show')).toContain('>Draft<');
  });
});

describe('empty states', () => {
  it('each list says so rather than rendering an empty table', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    expect(await (await get('/admin/newsletter', cookie)).text()).toContain(
      'No subscribers match',
    );
    expect(await (await get('/admin/news', cookie)).text()).toContain('No posts yet');
  });

  it('the newsletter search says so when nothing matches', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await db().insert(newsletterSubscribers).values({
      email: 'anna@example.com',
      subscribedAt: '2026-01-01',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });

    const found = await (await get('/admin/newsletter?q=anna', cookie)).text();
    expect(found).toContain('anna@example.com');

    const missed = await (await get('/admin/newsletter?q=zzzz', cookie)).text();
    expect(missed).toContain('No subscribers match');
  });

  it('the newsletter list can show unsubscribed people too', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await db().insert(newsletterSubscribers).values({
      email: 'gone@example.com',
      subscribedAt: '2026-01-01',
      unsubscribedAt: '2026-02-01',
      createdAt: '2026-01-01',
      updatedAt: '2026-02-01',
    });

    expect(await (await get('/admin/newsletter?status=active', cookie)).text()).toContain(
      'No subscribers match',
    );
    const all = await (await get('/admin/newsletter?status=unsubscribed', cookie)).text();
    expect(all).toContain('gone@example.com');
    expect(all).toContain('left 2026-02-01');
  });
});

describe('plurals', () => {
  it('says members, not member, when more than one changed', async () => {
    await db().insert(members).values([
      { id: 'a-one', name: 'A One', grade: 'Senior', visibility: MEMBER_VISIBILITY.Limited },
      { id: 'b-two', name: 'B Two', grade: 'Junior', visibility: MEMBER_VISIBILITY.Limited },
    ]);
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const form = new FormData();
    form.append('memberIds', 'a-one');
    form.append('memberIds', 'b-two');
    form.set('visibility', MEMBER_VISIBILITY.Full);
    form.set('acknowledged', '1');

    const res = await post('/admin/members/visibility', cookie, form);
    const html = await (await get(res.headers.get('location')!, cookie)).text();
    expect(html).toContain('Updated 2 members');
  });
});

describe('the invite confirmation', () => {
  it('reports that the invitation was sent', async () => {
    await db().insert(members).values({
      id: 'daniel-doser',
      name: 'Daniel Doser',
      grade: 'Senior',
      isActive: true,
    });
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const form = new FormData();
    form.set('email', 'newcomer@example.com');
    form.set('role', APP_ROLE.Member);
    form.set('memberId', 'daniel-doser');

    const res = await post('/admin/accounts/invite', cookie, form);
    expect(res.status).toBe(302);

    const html = await (await get(res.headers.get('location')!, cookie)).text();
    expect(html).toContain('newcomer@example.com');
  });
});

describe('two performances on one day', () => {
  it('are ordered by time, so a matinee precedes the evening show', async () => {
    await db().insert(shows).values({
      id: 'lightning-thief',
      title: 'The Lightning Thief',
      season: 'Spring 2026',
      year: 2026,
      synopsis: 'x',
    });

    await replacePerformances(db(), staff, 'lightning-thief', [
      { date: '2026-03-07', time: '7:30 PM' },
      { date: '2026-03-07', time: '2:00 PM' },
    ]);

    const rows = await db()
      .select()
      .from(showPerformances)
      .where(eq(showPerformances.showId, 'lightning-thief'))
      .orderBy(asc(showPerformances.id));

    expect(rows).toHaveLength(2);
    // Same date, so the comparator falls through to comparing the times.
    const times = rows.map((r) => r.time).sort();
    expect(times).toEqual(['2:00 PM', '7:30 PM']);
  });
});

describe('saving a cast that is not fully cast yet', () => {
  it('keeps the role and records it as TBA', async () => {
    await db().insert(shows).values({
      id: 'lightning-thief',
      title: 'The Lightning Thief',
      season: 'Spring 2026',
      year: 2026,
      synopsis: 'x',
    });
    await db().insert(members).values({
      id: 'daniel-doser',
      name: 'Daniel Doser',
      grade: 'Senior',
      isActive: true,
    });
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer, 'daniel-doser');

    const form = new FormData();
    form.append('role', 'Percy Jackson');
    form.append('memberId', 'daniel-doser');
    form.append('tier', 'lead');
    // Cast one part, leave the next unfilled - the normal state of a show
    // between auditions and the final list.
    form.append('role', 'Ensemble');
    form.append('memberId', '');
    form.append('tier', 'ensemble');

    await post('/admin/shows/lightning-thief/cast', cookie, form);

    const rows = await db()
      .select()
      .from(showCast)
      .where(eq(showCast.showId, 'lightning-thief'))
      .orderBy(asc(showCast.sortOrder));

    expect(rows.map((r) => [r.role, r.memberId])).toEqual([
      ['Percy Jackson', 'daniel-doser'],
      ['Ensemble', null],
    ]);
  });
});

describe('creating a show without naming a venue', () => {
  it('falls back to the auditorium the club always uses', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);

    const form = new FormData();
    form.set('title', 'Into the Woods');
    form.set('season', 'Fall 2026');
    form.set('year', '2026');
    form.set('venue', '');
    form.set('synopsis', 'Fairy tales collide.');
    form.set('ticketUrl', '');

    await post('/admin/shows/new', cookie, form);

    const [row] = await db().select().from(shows).where(eq(shows.id, 'into-the-woods-2026'));
    expect(row!.venue).toBe('Fairport High School Auditorium');
  });
});
