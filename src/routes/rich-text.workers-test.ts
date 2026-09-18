import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '~/db/queries';
import { members, MEMBER_VISIBILITY, showPerformances, shows } from '~/db/schema/content';
import { get, resetTables } from '~/test/session';

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
