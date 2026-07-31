import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { showPerformances, shows } from './schema/content';
import { getCurrentShow, getDb, getPastShows } from './queries';

/**
 * Show state is derived from performance dates rather than trusted from the
 * stored `isCurrent` flag.
 *
 * The flag is an editorial choice and it drifts: the real spring 2026
 * production stayed flagged current for five months after closing, so the
 * homepage kept advertising tickets for a show that had already run.
 */

const db = () => getDb(env.DB);

const iso = (daysFromNow: number) =>
  new Date(Date.now() + daysFromNow * 864e5).toISOString().slice(0, 10);

const seedShow = async (
  id: string,
  isCurrent: boolean,
  performanceDates: string[],
  isHighlighted = false,
) => {
  await db().insert(shows).values({
    id,
    title: `Show ${id}`,
    season: 'Test Season',
    year: 2026,
    synopsis: 'x',
    isCurrent,
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

describe('current show state', () => {
  it('is running while performances are still ahead', async () => {
    await seedShow('upcoming', true, [iso(10), iso(12)]);
    const show = await getCurrentShow(db());
    expect(show?.state).toBe('running');
  });

  it('is still running on closing day itself', async () => {
    await seedShow('closing-tonight', true, [iso(-2), iso(0)]);
    const show = await getCurrentShow(db());
    expect(show?.state).toBe('running');
  });

  // The actual bug this exists to prevent.
  it('is closed once the last performance has passed', async () => {
    await seedShow('finished', true, [iso(-40), iso(-38)]);
    const show = await getCurrentShow(db());
    expect(show?.state).toBe('closed');
  });

  it('is running when no performances are scheduled yet', async () => {
    // An announced show with no dates yet must not read as already over.
    await seedShow('announced', true, []);
    const show = await getCurrentShow(db());
    expect(show?.state).toBe('running');
  });

  it('returns null when no show is flagged current', async () => {
    await seedShow('past', false, [iso(-100)]);
    expect(await getCurrentShow(db())).toBeNull();
  });

  it('exposes the last performance date for the closing note', async () => {
    await seedShow('finished', true, [iso(-40), iso(-38)]);
    const show = await getCurrentShow(db());
    expect(show?.lastPerformance).toBe(iso(-38));
  });
});

describe('past shows include closed-but-still-flagged runs', () => {
  // Without this a closed show falls into limbo: no longer promoted, but
  // absent from the archive too, until someone clears the flag by hand.
  it('lists a show that is flagged current but has finished', async () => {
    await seedShow('finished', true, [iso(-40)]);
    const past = await getPastShows(db());
    expect(past.map((s) => s.id)).toContain('finished');
  });

  it('does not list a show that is still running', async () => {
    await seedShow('running', true, [iso(5)]);
    const past = await getPastShows(db());
    expect(past.map((s) => s.id)).not.toContain('running');
  });

  it('still lists ordinary past shows', async () => {
    await seedShow('old', false, [iso(-400)]);
    const past = await getPastShows(db());
    expect(past.map((s) => s.id)).toContain('old');
  });

  it('respects the highlighted filter', async () => {
    await seedShow('plain', false, [iso(-100)], false);
    await seedShow('starred', false, [iso(-100)], true);
    const highlighted = await getPastShows(db(), { highlightedOnly: true });
    expect(highlighted.map((s) => s.id)).toEqual(['starred']);
  });

  it('a closed current show can also be highlighted', async () => {
    await seedShow('finished-star', true, [iso(-40)], true);
    const highlighted = await getPastShows(db(), { highlightedOnly: true });
    expect(highlighted.map((s) => s.id)).toContain('finished-star');
  });
});

describe('a show appears in exactly one place', () => {
  it('a running show is featured and not archived', async () => {
    await seedShow('live', true, [iso(3)]);
    expect((await getCurrentShow(db()))?.state).toBe('running');
    expect((await getPastShows(db())).map((s) => s.id)).not.toContain('live');
  });

  // A closed run is deliberately in both: still on the homepage as ended, and
  // in the archive. That is the transition state, not a bug.
  it('a closed run is shown as ended and also archived', async () => {
    await seedShow('wrapped', true, [iso(-10)]);
    expect((await getCurrentShow(db()))?.state).toBe('closed');
    expect((await getPastShows(db())).map((s) => s.id)).toContain('wrapped');
  });
});
