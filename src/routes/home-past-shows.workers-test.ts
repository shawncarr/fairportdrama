import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import { SHOW_COMPANY, showPerformances, shows } from '~/db/schema/content';
import { get, resetTables } from '~/test/session';

/**
 * "Past Productions" on the home page.
 *
 * It listed one card - the same show as the hero - while three genuinely past
 * productions were missing. Two causes at once: the query filtered on
 * `isHighlighted`, which one show in four carried, and a closed show still
 * flagged current counts as finished, so the hero production also qualified as
 * its own past production.
 */

const db = () => getDb(env.DB);

const iso = (daysFromNow: number) =>
  new Date(Date.now() + daysFromNow * 864e5).toISOString().slice(0, 10);

async function seedShow(
  id: string,
  // Announced by default: every fixture here stands for a production that
  // actually ran, and an unannounced show is a draft with no public page.
  opts: { year: number; announced?: boolean; highlighted?: boolean; lastDate: string },
) {
  await db().insert(shows).values({
    id,
    title: id,
    season: 'Spring',
    year: opts.year,
    venue: 'Auditorium',
    synopsis: 'A show.',
    isAnnounced: opts.announced ?? true,
    isHighlighted: opts.highlighted ?? false,
  });
  await db().insert(showPerformances).values({
    id: `${id}-p`,
    showId: id,
    date: opts.lastDate,
    time: '19:00',
  });
}

const body = async (path: string) => (await get(path)).text();

/**
 * The ids rendered in the Past Productions grid, in order.
 *
 * Bounded by the closing tag of that section. The section's own "All shows"
 * link now points at /shows, which the id pattern below cannot match, so it
 * needs no special case - it used to point at /shows/past and read as a show
 * called "past".
 */
const listed = async () => {
  const body = await (await get('/')).text();
  const start = body.indexOf('Past Productions');
  if (start === -1) return [];

  const end = body.indexOf('</section>', start);
  const section = body.slice(start, end === -1 ? undefined : end);

  return [...section.matchAll(/href="\/shows\/([a-z0-9-]+)"/g)].map((m) => m[1]!);
};

beforeEach(async () => {
  await resetTables(['show_cast', 'show_crew', 'show_gallery_images', 'show_performances', 'shows']);
});

describe('which shows are listed', () => {
  // An upcoming production, so the hero is drawn from the season rather than
  // from the archive. Every fixture below is now announced - announcement is
  // what makes a show public - and without this the most recent closed one
  // becomes the wrap hero and is filtered out of the very list under test.
  beforeEach(async () => {
    await seedShow('this-season', { year: 2027, lastDate: iso(30) });
  });

  it('lists past productions that were never highlighted', async () => {
    await seedShow('charlottes-web', { year: 2025, lastDate: iso(-400) });
    await seedShow('hadestown', { year: 2025, lastDate: iso(-380) });

    // Both were absent before: neither carried the flag the query filtered on.
    const ids = await listed();
    expect(ids).toContain('charlottes-web');
    expect(ids).toContain('hadestown');
  });

  it('does not repeat the show already in the hero', async () => {
    // This one wants the wrap hero specifically - a closed show standing in
    // as the hero because nothing is upcoming - so it drops the block's
    // upcoming fixture rather than inheriting it.
    await db().delete(shows).where(eq(shows.id, 'this-season'));

    await seedShow('lightning-thief', {
      year: 2026,
      announced: true,
      highlighted: true,
      lastDate: iso(-150),
    });
    await seedShow('charlottes-web', { year: 2025, lastDate: iso(-400) });

    // Its run has closed, so it counts as finished - but it is the hero, and
    // listing it again underneath was the whole of the section.
    expect(await listed()).toEqual(['charlottes-web']);
  });

  it('still lists a closed show once nothing is flagged current', async () => {
    await seedShow('lightning-thief', { year: 2026, lastDate: iso(-150) });

    expect(await listed()).toContain('lightning-thief');
  });

  it('leaves out a show that is still running', async () => {
    await seedShow('running-now', { year: 2026, announced: true, lastDate: iso(30) });
    await seedShow('charlottes-web', { year: 2025, lastDate: iso(-400) });

    expect(await listed()).toEqual(['charlottes-web']);
  });

  it('shows nothing rather than an empty heading when there are none', async () => {
    await seedShow('running-now', { year: 2026, announced: true, lastDate: iso(30) });

    const body = await (await get('/')).text();
    expect(body).not.toContain('Past Productions');
  });
});

describe('ordering', () => {
  // An upcoming production, so the hero is drawn from the season rather than
  // from the archive. Every fixture below is now announced - announcement is
  // what makes a show public - and without this the most recent closed one
  // becomes the wrap hero and is filtered out of the very list under test.
  beforeEach(async () => {
    await seedShow('this-season', { year: 2027, lastDate: iso(30) });
  });

  it('puts highlighted shows first, then the most recent', async () => {
    await seedShow('old-plain', { year: 2022, lastDate: iso(-1400) });
    await seedShow('new-plain', { year: 2025, lastDate: iso(-400) });
    await seedShow('old-starred', { year: 2023, highlighted: true, lastDate: iso(-1000) });

    // Highlighting orders rather than filters now, so the admin checkbox still
    // does something and the section still fills up without it.
    expect(await listed()).toEqual(['old-starred', 'new-plain', 'old-plain']);
  });

  it('is newest first when nothing is highlighted', async () => {
    await seedShow('a-2023', { year: 2023, lastDate: iso(-1000) });
    await seedShow('b-2025', { year: 2025, lastDate: iso(-400) });

    expect(await listed()).toEqual(['b-2025', 'a-2023']);
  });

  it('shows at most three, so the home page does not become the archive', async () => {
    // A distinct closing date per year. They once shared one, and the order
    // came from `year` alone - which the page no longer sorts on, because
    // `year` is hand-entered and can disagree with the dates.
    for (const year of [2021, 2022, 2023, 2024, 2025]) {
      await seedShow(`show-${year}`, { year, lastDate: iso(-400 - (2025 - year) * 365) });
    }

    const ids = await listed();
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(['show-2025', 'show-2024', 'show-2023']);
  });
});

describe('the archive is unaffected', () => {
  it('lists every past show, including ones the home page trimmed', async () => {
    for (const year of [2021, 2022, 2023, 2024, 2025]) {
      await seedShow(`show-${year}`, { year, lastDate: iso(-400) });
    }

    const body = await (await get('/shows')).text();
    for (const year of [2021, 2022, 2023, 2024, 2025]) {
      expect(body, String(year)).toContain(`show-${year}`);
    }
  });
});

describe('concurrent shows', () => {
  it('heroes the soonest show and bands the rest', async () => {
    await seedShow('varsity-show', { year: 2027, announced: true, lastDate: iso(10) });
    await seedShow('jv-show', { year: 2027, announced: true, lastDate: iso(25) });

    const html = await body('/');

    // Match the links, not the bare ids. The hero's title is interpolated
    // into <meta name="description"> (home.tsx:449), so `indexOf('varsity-
    // show')` finds it in <head> and compares as "before" everything in the
    // body no matter what the page renders.
    const band = html.indexOf('Also this season');
    const heroLink = html.indexOf('href="/shows/varsity-show"');
    const bandLink = html.indexOf('href="/shows/jv-show"');

    expect(band).toBeGreaterThan(-1);
    expect(heroLink).toBeGreaterThan(-1);
    expect(bandLink).toBeGreaterThan(-1);

    expect(heroLink).toBeLessThan(band);
    expect(band).toBeLessThan(bandLink);

    // The hero must not also be dealt into the band - that is the duplicated
    // production this whole filter exists to prevent.
    expect(html.slice(band)).not.toContain('href="/shows/varsity-show"');
  });

  it('shows the company label on the home hero, never the slug', async () => {
    await seedShow('jv-show', { year: 2027, announced: true, lastDate: iso(10) });
    await db().update(shows).set({ company: SHOW_COMPANY.Jv });

    // The hero's badge is a third copy of this markup, separate from
    // ShowCard's and the show page's.
    const html = await body('/');
    expect(html).toContain('>JV<');
    expect(html).not.toContain('>jv<');
  });

  it('hides the band when only one show is upcoming', async () => {
    await seedShow('only-show', { year: 2027, announced: true, lastDate: iso(10) });

    expect(await body('/')).not.toContain('Also this season');
  });

  it('keeps the wrap hero when every announced show has closed', async () => {
    await seedShow('closed-show', { year: 2026, announced: true, lastDate: iso(-30) });

    const html = await body('/');
    expect(html).toContain('a wrap');
    expect(html).not.toContain('Also this season');
  });

  it('says the dates are unset rather than rendering a blank line', async () => {
    await db().insert(shows).values({
      id: 'no-dates-yet',
      title: 'no-dates-yet',
      season: 'Fall 2027',
      year: 2027,
      synopsis: 'Announced before the schedule locked.',
      isAnnounced: true,
    });

    expect(await body('/')).toContain('Dates to be announced');
  });

  // Named for what it actually pins. The `promotedIds` filter is exercised by
  // 'does not repeat the show already in the hero', where a closed announced
  // show is both the wrap hero and a genuine past production. Here the
  // upcoming show never reaches getPastShows at all, so dropping the filter
  // leaves this green.
  it('keeps an upcoming show out of the past section', async () => {
    await seedShow('upcoming-show', { year: 2027, announced: true, lastDate: iso(10) });
    await seedShow('older-show', { year: 2024, lastDate: iso(-400) });

    const html = await body('/');

    // The section is conditional (home.tsx:281). Absent, indexOf is -1 and
    // slice(-1) is the last character of the page, which contains nothing -
    // so the assertion would pass without the filter working at all.
    const pastIndex = html.indexOf('Past Productions');
    expect(pastIndex).toBeGreaterThan(-1);

    const pastSection = html.slice(pastIndex);
    expect(pastSection).toContain('older-show');
    expect(pastSection).not.toContain('upcoming-show');
  });
});
