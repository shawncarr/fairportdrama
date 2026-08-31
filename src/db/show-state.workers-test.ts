import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SHOW_COMPANY,
  members,
  showCast,
  showPerformances,
  shows,
  type ShowCompany,
} from './schema/content';
import {
  getDb,
  getIndexableShows,
  getLastClosedAnnouncedShow,
  getMemberShows,
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
 * Every `iso()` date here is at least three days clear of today on purpose.
 * `iso()` derives from the UTC date while the queries compare against
 * America/New_York, so a single day either side is ambiguous between 20:00 ET
 * and midnight. The one test that needs the boundary exactly uses `etToday()`
 * instead.
 */

const db = () => getDb(env.DB);

const iso = (daysFromNow: number) =>
  new Date(Date.now() + daysFromNow * 864e5).toISOString().slice(0, 10);

/**
 * Today in the club's timezone, mirroring `today()` in queries.ts.
 *
 * `iso(0)` is the UTC date, which from 20:00 ET is already tomorrow, so it
 * cannot reliably say "the last performance is tonight". This can.
 */
const etToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const seedShow = async (
  id: string,
  isAnnounced: boolean,
  performanceDates: string[],
  company: ShowCompany | null = null,
) => {
  await db().insert(shows).values({
    id,
    title: `Show ${id}`,
    season: 'Test Season',
    year: 2026,
    synopsis: 'x',
    isAnnounced,
    company,
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

  // The column the concurrent-run work exists to carry. Null for a show the
  // club stages as one group, which is most of them.
  it('projects the company that staged a split slot', async () => {
    await seedShow('a-jv', true, [iso(5)], SHOW_COMPANY.Jv);
    await seedShow('b-whole-club', true, [iso(6)]);

    const [jv, wholeClub] = await getPromotedShows(db());
    expect(jv!.company).toBe('jv');
    expect(wholeClub!.company).toBeNull();
  });

  // Same opening night, so the title is the only thing left to order them by.
  // Seeded varsity-first, so without the tiebreak the scan order wins.
  it('breaks a shared opening night on the title', async () => {
    await seedShow('varsity', true, [iso(5)]);
    await seedShow('jv', true, [iso(5)]);

    expect((await getPromotedShows(db())).map((s) => s.id)).toEqual(['jv', 'varsity']);
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

  it('breaks a shared closing night on the title', async () => {
    await seedShow('varsity', false, [iso(-10)]);
    await seedShow('jv', false, [iso(-10)]);

    expect((await getPastShows(db())).map((s) => s.id)).toEqual(['jv', 'varsity']);
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

  // A JV and a Varsity show sharing a closing weekend is the case this whole
  // change exists for. Without a tiebreak the wrap state names one at random.
  it('breaks a shared closing night on the title', async () => {
    await seedShow('varsity', true, [iso(-5)]);
    await seedShow('jv', true, [iso(-5)]);

    expect((await getLastClosedAnnouncedShow(db()))!.id).toBe('jv');
  });
});

describe('getMemberShows', () => {
  it('leaves a draft off a member credit list', async () => {
    await seedShow('announced-show', true, [iso(10)]);
    await seedShow('draft-show', false, [iso(20)]);
    await db().insert(members).values({ id: 'kid', name: 'A Student', grade: 'Junior' });
    await db().insert(showCast).values([
      { id: 'c1', showId: 'announced-show', memberId: 'kid', role: 'Lead' },
      { id: 'c2', showId: 'draft-show', memberId: 'kid', role: 'Lead' },
    ]);

    // The route gate hides /shows/draft-show. A title on the student's own
    // profile would disclose the same show, with a link that 404s.
    expect((await getMemberShows(db(), 'kid')).map((s) => s.id)).toEqual([
      'announced-show',
    ]);
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

  it('reports a past show as closed and not a draft, announced or not', async () => {
    await seedShow('old', false, [iso(-20)]);

    const show = await getShow(db(), 'old');
    expect(show!.isDraft).toBe(false);
    expect(show!.closed).toBe(true);
  });
});

/**
 * The boundary the whole derivation turns on, and the only test that sits on
 * it. Every other date in this file is days clear, so `<` could become `<=` -
 * closing a show on its own closing night, while the audience is still in the
 * lobby - and nothing else here would notice.
 */
describe('closing night', () => {
  it('leaves a show promoted, out of the archive, and open on its last day', async () => {
    await seedShow('closing-tonight', true, [iso(-4), etToday()]);

    expect((await getPromotedShows(db())).map((s) => s.id)).toEqual(['closing-tonight']);
    expect(await getPastShows(db())).toEqual([]);
    expect((await getShow(db(), 'closing-tonight'))!.closed).toBe(false);
  });
});
