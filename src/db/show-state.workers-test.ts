import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { showPerformances, shows } from './schema/content';
import {
  getDb,
  getIndexableShows,
  getLastClosedAnnouncedShow,
  getPastShows,
  getPromotedShows,
  getShow,
} from './queries';

/**
 * Show state is derived from performance dates crossed with the stored
 * `isAnnounced` flag, rather than trusted from the flag alone.
 *
 * The flag is an editorial choice and it drifts: the real spring 2026
 * production stayed flagged current for five months after closing, so the
 * homepage kept advertising tickets for a show that had already run.
 *
 * Every past date here is at least three days back on purpose. `iso()`
 * derives from the UTC date while the queries compare against
 * America/New_York, so a single day back is ambiguous between 20:00 ET and
 * midnight.
 */

const db = () => getDb(env.DB);

const iso = (daysFromNow: number) =>
  new Date(Date.now() + daysFromNow * 864e5).toISOString().slice(0, 10);

const seedShow = async (
  id: string,
  isAnnounced: boolean,
  performanceDates: string[],
  isHighlighted = false,
) => {
  await db().insert(shows).values({
    id,
    title: `Show ${id}`,
    season: 'Test Season',
    year: 2026,
    synopsis: 'x',
    isAnnounced,
    isHighlighted,
  });
  if (performanceDates.length > 0) {
    await db()
      .insert(showPerformances)
      .values(
        performanceDates.map((date, i) => ({
          id: `${id}-p${i}`,
          showId: id,
          date,
          time: '7:30 PM',
        })),
      );
  }
};

beforeEach(async () => {
  await env.DB.exec('DELETE FROM show_performances');
  await env.DB.exec('DELETE FROM shows');
});

describe('getPromotedShows', () => {
  it('returns every announced show that has not closed, soonest first', async () => {
    await seedShow('late', true, [iso(60), iso(61)]);
    await seedShow('soon', true, [iso(5), iso(6)]);
    await seedShow('draft', false, [iso(10)]);

    const promoted = await getPromotedShows(db());
    expect(promoted.map((s) => s.id)).toEqual(['soon', 'late']);
  });

  // Ids chosen so the asc(title) tiebreak pulls the opposite way: sorted by
  // title alone this is ['a-undated', 'z-dated']. Only the NULL-last sort key
  // produces the expected order, so the test fails if that key inverts.
  it('sorts a show with no dates yet after every dated one', async () => {
    await seedShow('z-dated', true, [iso(30)]);
    await seedShow('a-undated', true, []);

    const promoted = await getPromotedShows(db());
    expect(promoted.map((s) => s.id)).toEqual(['z-dated', 'a-undated']);
  });

  it('drops a show the day after it closes', async () => {
    await seedShow('closed', true, [iso(-4), iso(-3)]);

    expect(await getPromotedShows(db())).toEqual([]);
  });

  // Two shows with disjoint runs, deliberately. Seeded with one, an
  // uncorrelated subquery - a global MIN/MAX over every performance row -
  // returns the same answer and the test passes while the correlation is
  // broken. Drizzle renders an interpolated `${shows.id}` as a bare `"id"`
  // that binds inside the subquery, which is exactly how that happens.
  it('projects each show its own endpoints, not the table-wide ones', async () => {
    await seedShow('early', true, [iso(5), iso(9), iso(7)]);
    await seedShow('later', true, [iso(20), iso(25)]);

    const [early, later] = await getPromotedShows(db());
    expect([early!.firstPerformance, early!.lastPerformance]).toEqual([iso(5), iso(9)]);
    expect([later!.firstPerformance, later!.lastPerformance]).toEqual([iso(20), iso(25)]);
  });
});

describe('getPastShows', () => {
  it('holds closed shows whether or not they are announced', async () => {
    await seedShow('announced-closed', true, [iso(-10)]);
    await seedShow('archived', false, [iso(-20)]);

    const past = await getPastShows(db());
    expect(past.map((s) => s.id).sort()).toEqual(['announced-closed', 'archived']);
  });

  it('never holds a show with no dates at all', async () => {
    await seedShow('draft', false, []);

    expect(await getPastShows(db())).toEqual([]);
  });

  it('orders by when the run ended', async () => {
    await seedShow('fall', false, [iso(-200)]);
    await seedShow('spring', false, [iso(-20)]);

    const past = await getPastShows(db());
    expect(past.map((s) => s.id)).toEqual(['spring', 'fall']);
  });
});

describe('getLastClosedAnnouncedShow', () => {
  it('picks the most recent closed announced show', async () => {
    await seedShow('older', true, [iso(-100)]);
    await seedShow('newer', true, [iso(-5)]);
    await seedShow('unannounced', false, [iso(-3)]);

    const show = await getLastClosedAnnouncedShow(db());
    expect(show!.id).toBe('newer');
  });
});

describe('getIndexableShows', () => {
  it('holds announced and past shows but never a draft', async () => {
    await seedShow('upcoming', true, [iso(5)]);
    await seedShow('past', false, [iso(-5)]);
    await seedShow('draft', false, [iso(5)]);

    const ids = (await getIndexableShows(db())).map((s) => s.id).sort();
    expect(ids).toEqual(['past', 'upcoming']);
  });
});

describe('getShow', () => {
  it('marks an unannounced future show as a draft', async () => {
    await seedShow('staged', false, [iso(20)]);

    expect((await getShow(db(), 'staged'))!.isDraft).toBe(true);
  });

  it('does not mark a past show as a draft, announced or not', async () => {
    await seedShow('old', false, [iso(-20)]);

    expect((await getShow(db(), 'old'))!.isDraft).toBe(false);
  });
});
