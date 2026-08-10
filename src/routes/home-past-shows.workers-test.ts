import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '~/db/queries';
import { showPerformances, shows } from '~/db/schema/content';
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
  opts: { year: number; current?: boolean; highlighted?: boolean; lastDate: string },
) {
  await db().insert(shows).values({
    id,
    title: id,
    season: 'Spring',
    year: opts.year,
    venue: 'Auditorium',
    synopsis: 'A show.',
    isCurrent: opts.current ?? false,
    isHighlighted: opts.highlighted ?? false,
  });
  await db().insert(showPerformances).values({
    id: `${id}-p`,
    showId: id,
    date: opts.lastDate,
    time: '19:00',
  });
}

/**
 * The ids rendered in the Past Productions grid, in order.
 *
 * Bounded by the closing tag of that section, and with the section's own
 * "All shows" link dropped - it points at /shows/past, which would otherwise
 * read as a show called "past".
 */
const listed = async () => {
  const body = await (await get('/')).text();
  const start = body.indexOf('Past Productions');
  if (start === -1) return [];

  const end = body.indexOf('</section>', start);
  const section = body.slice(start, end === -1 ? undefined : end);

  return [...section.matchAll(/href="\/shows\/([a-z0-9-]+)"/g)]
    .map((m) => m[1]!)
    .filter((id) => id !== 'past' && id !== 'current');
};

beforeEach(async () => {
  await resetTables(['show_cast', 'show_crew', 'show_gallery_images', 'show_performances', 'shows']);
});

describe('which shows are listed', () => {
  it('lists past productions that were never highlighted', async () => {
    await seedShow('charlottes-web', { year: 2025, lastDate: iso(-400) });
    await seedShow('hadestown', { year: 2025, lastDate: iso(-380) });

    // Both were absent before: neither carried the flag the query filtered on.
    const ids = await listed();
    expect(ids).toContain('charlottes-web');
    expect(ids).toContain('hadestown');
  });

  it('does not repeat the show already in the hero', async () => {
    await seedShow('lightning-thief', {
      year: 2026,
      current: true,
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
    await seedShow('running-now', { year: 2026, current: true, lastDate: iso(30) });
    await seedShow('charlottes-web', { year: 2025, lastDate: iso(-400) });

    expect(await listed()).toEqual(['charlottes-web']);
  });

  it('shows nothing rather than an empty heading when there are none', async () => {
    await seedShow('running-now', { year: 2026, current: true, lastDate: iso(30) });

    const body = await (await get('/')).text();
    expect(body).not.toContain('Past Productions');
  });
});

describe('ordering', () => {
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
    for (const year of [2021, 2022, 2023, 2024, 2025]) {
      await seedShow(`show-${year}`, { year, lastDate: iso(-400) });
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

    const body = await (await get('/shows/past')).text();
    for (const year of [2021, 2022, 2023, 2024, 2025]) {
      expect(body, String(year)).toContain(`show-${year}`);
    }
  });
});
