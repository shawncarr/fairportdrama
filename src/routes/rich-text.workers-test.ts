import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '~/db/queries';
import { members, MEMBER_VISIBILITY, showPerformances, shows } from '~/db/schema/content';
import { APP_ROLE, pendingEdits } from '~/db/schema/governance';
import { RICH_TEXT_MAX_LENGTH } from '~/lib/rich-text';
import { get, post, resetTables, signIn } from '~/test/session';

/**
 * Synopses and bios are stored as markdown written in the admin's rich text
 * editor. These check what reaches visitors: formatting where the page has
 * room for it, plain words where it does not.
 */

const db = () => getDb(env.DB);

const body = async (path: string) => {
  const res = await get(path);
  expect(res.status, `${path} did not render`).toBe(200);
  return res.text();
};

const metaDescription = (html: string) =>
  html.match(/<meta name="description" content="([^"]*)"/)?.[1];

beforeEach(async () => {
  await resetTables(['show_performances', 'shows', 'members']);
});

describe('a show synopsis', () => {
  beforeEach(async () => {
    await db().insert(shows).values({
      id: 'lightning-thief',
      title: 'The Lightning Thief',
      season: 'Spring 2099',
      year: 2099,
      synopsis: 'A **demigod** quest across America.\n\nSecond paragraph.',
      isAnnounced: true,
    });
    await db().insert(showPerformances).values({
      id: 'perf-1',
      showId: 'lightning-thief',
      date: '2099-05-01',
      time: '7:30 PM',
    });
  });

  it('is formatted on the show page', async () => {
    const html = await body('/shows/lightning-thief');
    expect(html).toContain('<strong>demigod</strong>');
    expect(html).toContain('<p>Second paragraph.</p>');
  });

  it('is plain words in the show page description', async () => {
    const html = await body('/shows/lightning-thief');
    expect(metaDescription(html)).toBe('A demigod quest across America. Second paragraph.');
  });

  it('is plain words in the home page hero and description', async () => {
    const html = await body('/');
    expect(html).toContain('A demigod quest across America. Second paragraph.');
    expect(html).not.toContain('**demigod**');
    expect(metaDescription(html)).not.toContain('**');
  });
});

describe('a member bio', () => {
  beforeEach(async () => {
    await db().insert(members).values({
      id: 'daniel-doser',
      name: 'Daniel Doser',
      grade: 'Senior',
      bio: 'Playing **Percy**.\n\n# Big news',
      visibility: MEMBER_VISIBILITY.Full,
      isActive: true,
    });
  });

  it('keeps emphasis but shows a heading as typed', async () => {
    const html = await body('/members/daniel-doser');
    expect(html).toContain('<strong>Percy</strong>');
    expect(html).toContain('# Big news');
    expect(html).not.toContain('<h1>Big news');
  });

  it('is plain words in the description', async () => {
    const html = await body('/members/daniel-doser');
    expect(metaDescription(html)).toBe('Playing Percy. Big news');
  });
});

describe('the length limit', () => {
  const tooLong = 'x'.repeat(RICH_TEXT_MAX_LENGTH + 1);
  const justRight = 'x'.repeat(RICH_TEXT_MAX_LENGTH);

  beforeEach(async () => {
    await db().insert(members).values({
      id: 'daniel-doser',
      name: 'Daniel Doser',
      grade: 'Senior',
      bio: 'Original bio.',
      visibility: MEMBER_VISIBILITY.Limited,
    });
    await db().insert(shows).values({
      id: 'into-the-woods-2026',
      title: 'Into the Woods',
      season: 'Fall 2026',
      year: 2026,
      synopsis: 'Fairy tales collide.',
    });
  });

  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };

  it('refuses an over-long bio from the member', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    const res = await post('/admin/profile', cookie, form({ visibility: MEMBER_VISIBILITY.Limited, bio: tooLong, instagram: '' }));
    expect(res.headers.get('location')).toContain('error=');
    expect(await db().select().from(pendingEdits)).toHaveLength(0);
  });

  it('accepts a bio exactly at the limit', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    const res = await post('/admin/profile', cookie, form({ visibility: MEMBER_VISIBILITY.Limited, bio: justRight, instagram: '' }));
    expect(res.headers.get('location')).not.toContain('error=');
  });

  it('refuses an over-long bio from an admin', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const res = await post('/admin/members/daniel-doser', cookie, form({
      name: 'Daniel Doser', grade: 'Senior', graduationYear: '2026', bio: tooLong,
      instagram: '', visibility: MEMBER_VISIBILITY.Limited, isActive: '1',
    }));
    expect(res.headers.get('location')).toContain('error=');
    const [row] = await db().select().from(members);
    expect(row!.bio).toBe('Original bio.');
  });

  it('refuses an over-long synopsis on a new show', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);
    const res = await post('/admin/shows/new', cookie, form({
      title: 'Wicked', season: 'Spring 2027', year: '2027', venue: '', synopsis: tooLong, ticketUrl: '',
    }));
    expect(res.headers.get('location')).toContain('error=');
    expect(await db().select().from(shows)).toHaveLength(1);
  });

  it('refuses an over-long synopsis on an existing show', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);
    const res = await post('/admin/shows/into-the-woods-2026/details', cookie, form({
      title: 'Into the Woods', season: 'Fall 2026', year: '2026', venue: '', synopsis: tooLong, ticketUrl: '',
    }));
    expect(res.headers.get('location')).toContain('error=');
    const [row] = await db().select().from(shows);
    expect(row!.synopsis).toBe('Fairy tales collide.');
  });
});
