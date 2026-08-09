import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import * as schema from './schema';
import {
  MEMBER_VISIBILITY,
  members,
  memberOffices,
  memberRoles,
  news,
  showCast,
  showCrew,
  showGalleryImages,
  showPerformances,
  shows,
  sponsors,
  spiritWear,
} from './schema/content';
import { toPublicMember, type DisplayableMember } from '~/lib/member-display';

export type DB = DrizzleD1Database<typeof schema>;
export const getDb = (binding: D1Database): DB => drizzle(binding, { schema });

// ---------------------------------------------------------------- shows

/**
 * The last scheduled performance date for a show, as a correlated subquery.
 *
 * Show state is derived from this rather than from the stored `isCurrent`
 * flag alone. The flag is an editorial choice - "feature this show" - and it
 * drifts: the spring 2026 production stayed flagged current for five months
 * after closing, so the homepage went on advertising tickets for a show that
 * had already run.
 */
// The outer column reference is written literally rather than interpolated.
// Drizzle renders `${shows.id}` inside a raw sql template as an unqualified
// `"id"`, which inside this subquery binds to show_performances.id instead of
// shows.id - so the correlation silently matched nothing and returned NULL for
// every row rather than failing.
const lastPerformanceDate = sql<string | null>`(
  SELECT MAX(p.date) FROM show_performances p WHERE p.show_id = ${sql.raw('"shows"."id"')}
)`;

/** Today in the club's timezone, as a bare ISO date for comparison. */
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

export type ShowState = 'running' | 'closed';

/**
 * The featured show, with whether its run has finished.
 *
 * A closed show is still returned: the homepage keeps showing it, but as an
 * ended run rather than an upcoming one. Hiding it outright the morning after
 * closing night would be more surprising than marking it over.
 */
export async function getCurrentShow(db: DB) {
  const [row] = await db
    .select({
      id: shows.id,
      title: shows.title,
      season: shows.season,
      year: shows.year,
      venue: shows.venue,
      synopsis: shows.synopsis,
      ticketUrl: shows.ticketUrl,
      posterImageId: shows.posterImageId,
      heroImageId: shows.heroImageId,
      ogImageId: shows.ogImageId,
      isCurrent: shows.isCurrent,
      isHighlighted: shows.isHighlighted,
      lastPerformance: lastPerformanceDate,
    })
    .from(shows)
    .where(eq(shows.isCurrent, true))
    .limit(1);

  if (!row) return null;

  const state: ShowState =
    row.lastPerformance && row.lastPerformance < today() ? 'closed' : 'running';

  return { ...row, state };
}

export async function getShow(db: DB, id: string) {
  const [row] = await db.select().from(shows).where(eq(shows.id, id)).limit(1);
  return row ?? null;
}

/**
 * Shows that have finished.
 *
 * Includes a show still flagged `isCurrent` whose run has ended. Without that,
 * closing a show would drop it into limbo - no longer promoted on the
 * homepage, but absent from the archive too - until someone remembered to
 * clear the flag by hand.
 */
export async function getPastShows(db: DB, opts: { highlightedOnly?: boolean } = {}) {
  const finished = or(
    eq(shows.isCurrent, false),
    sql`${lastPerformanceDate} IS NOT NULL AND ${lastPerformanceDate} < ${today()}`,
  );

  return db
    .select()
    .from(shows)
    .where(opts.highlightedOnly ? and(finished, eq(shows.isHighlighted, true)) : finished)
    .orderBy(desc(shows.year));
}

export async function getPerformances(db: DB, showId: string) {
  return db
    .select()
    .from(showPerformances)
    .where(eq(showPerformances.showId, showId))
    .orderBy(asc(showPerformances.date));
}

export async function getGallery(db: DB, showId: string) {
  return db
    .select()
    .from(showGalleryImages)
    .where(eq(showGalleryImages.showId, showId))
    .orderBy(asc(showGalleryImages.sortOrder));
}

/**
 * Cast list with member names already reduced to their public form.
 *
 * The join returns the stored name and visibility, but only the projected
 * result leaves this function. Templates never see a raw member row, so a new
 * render site cannot accidentally print a surname a member withheld.
 */
export async function getCast(db: DB, showId: string) {
  const rows = await db
    .select({
      id: showCast.id,
      role: showCast.role,
      additionalRoles: showCast.additionalRoles,
      tier: showCast.tier,
      memberId: showCast.memberId,
      name: members.name,
      visibility: members.visibility,
      photoImageId: members.photoImageId,
    })
    .from(showCast)
    .leftJoin(members, eq(members.id, showCast.memberId))
    .where(eq(showCast.showId, showId))
    .orderBy(asc(showCast.sortOrder));

  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    additionalRoles: r.additionalRoles ?? [],
    tier: r.tier,
    // A null memberId is an uncast role, rendered as TBA rather than omitted:
    // the audience should see the part exists.
    member:
      r.memberId && r.name && r.visibility
        ? toPublicMember({
            id: r.memberId,
            name: r.name,
            visibility: r.visibility,
            photoImageId: r.photoImageId,
          } satisfies DisplayableMember)
        : null,
  }));
}

export async function getCrew(db: DB, showId: string) {
  const rows = await db
    .select({
      id: showCrew.id,
      role: showCrew.role,
      memberId: showCrew.memberId,
      name: members.name,
      visibility: members.visibility,
    })
    .from(showCrew)
    .leftJoin(members, eq(members.id, showCrew.memberId))
    .where(eq(showCrew.showId, showId))
    .orderBy(asc(showCrew.sortOrder));

  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    member:
      r.memberId && r.name && r.visibility
        ? toPublicMember({ id: r.memberId, name: r.name, visibility: r.visibility })
        : null,
  }));
}

// ---------------------------------------------------------------- members

/**
 * Formats a term the way anyone would say it: "2025-2026", or "2025-present"
 * while it is still held.
 */
export const formatTerm = (startYear: number, endYear: number | null): string =>
  `${startYear}\u2013${endYear ?? 'present'}`;

export interface HeldOffice {
  title: string;
  startYear: number;
  endYear: number | null;
  term: string;
  isCurrent: boolean;
}

const toOffice = (o: { title: string; startYear: number; endYear: number | null }): HeldOffice => ({
  title: o.title,
  startYear: o.startYear,
  endYear: o.endYear,
  term: formatTerm(o.startYear, o.endYear),
  isCurrent: o.endYear === null,
});

/**
 * Every office held by members currently on the roster, newest first.
 *
 * Joined rather than filtered by a list of member ids. Binding one parameter
 * per member looked fine locally and failed on D1, which caps how many a
 * single statement may carry - the roster is 128 people, so the directory
 * broke while a single profile, binding one id, did not.
 */
async function officesForActiveMembers(db: DB) {
  const rows = await db
    .select({
      memberId: memberOffices.memberId,
      title: memberOffices.title,
      startYear: memberOffices.startYear,
      endYear: memberOffices.endYear,
    })
    .from(memberOffices)
    .innerJoin(members, eq(members.id, memberOffices.memberId))
    .where(eq(members.isActive, true))
    .orderBy(desc(memberOffices.startYear));

  const byMember = new Map<string, HeldOffice[]>();
  for (const row of rows) {
    const list = byMember.get(row.memberId) ?? [];
    list.push(toOffice(row));
    byMember.set(row.memberId, list);
  }
  return byMember;
}

/** One member's offices. A single bound id, so no list is involved. */
async function officesForMember(db: DB, memberId: string): Promise<HeldOffice[]> {
  const rows = await db
    .select()
    .from(memberOffices)
    .where(eq(memberOffices.memberId, memberId))
    .orderBy(desc(memberOffices.startYear));
  return rows.map(toOffice);
}

export async function getActiveMembers(db: DB) {
  const rows = await db
    .select()
    .from(members)
    .where(eq(members.isActive, true))
    .orderBy(asc(members.name));

  const offices = await officesForActiveMembers(db);

  return rows.map((r) => {
    const held = offices.get(r.id) ?? [];
    const current = held.find((o) => o.isCurrent) ?? null;
    return {
      ...toPublicMember(r),
      grade: r.grade,
      // Derived, not stored. There is no flag that can disagree with the
      // office records.
      isOfficer: current !== null,
      officerTitle: current?.title ?? null,
      offices: held,
    };
  });
}

/**
 * A member's public detail page.
 *
 * Returns null for `limited` members so the route 404s. This is the query
 * layer refusing to serve the page at all, rather than a template deciding to
 * render less of it - the URL itself carries the full name.
 */
export async function getPublicMemberProfile(db: DB, id: string) {
  const [row] = await db
    .select()
    .from(members)
    .where(and(eq(members.id, id), eq(members.visibility, MEMBER_VISIBILITY.Full)))
    .limit(1);

  if (!row) return null;

  const roles = await db
    .select({ role: memberRoles.role })
    .from(memberRoles)
    .where(eq(memberRoles.memberId, id));

  const held = await officesForMember(db, id);
  const current = held.find((o) => o.isCurrent) ?? null;

  return {
    ...toPublicMember(row),
    grade: row.grade,
    graduationYear: row.graduationYear,
    isOfficer: current !== null,
    officerTitle: current?.title ?? null,
    offices: held,
    roles: roles.map((r) => r.role),
  };
}

/** Slugs eligible for the sitemap. Limited members are absent by construction. */
export async function getIndexableMemberIds(db: DB) {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.isActive, true), eq(members.visibility, MEMBER_VISIBILITY.Full)));
  return rows.map((r) => r.id);
}

export async function getMemberShows(db: DB, memberId: string) {
  return db
    .select({ id: shows.id, title: shows.title, year: shows.year, season: shows.season })
    .from(shows)
    .where(
      sql`${shows.id} IN (
        SELECT show_id FROM show_cast WHERE member_id = ${memberId}
        UNION
        SELECT show_id FROM show_crew WHERE member_id = ${memberId}
      )`,
    )
    .orderBy(desc(shows.year));
}

// ---------------------------------------------------------------- news

export async function getPublishedNews(db: DB, limit?: number) {
  const q = db
    .select()
    .from(news)
    .where(eq(news.isDraft, false))
    .orderBy(desc(news.publishedAt));
  return limit ? q.limit(limit) : q;
}

export async function getNewsPost(db: DB, id: string) {
  const [row] = await db
    .select()
    .from(news)
    .where(and(eq(news.id, id), eq(news.isDraft, false)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------- sponsors, merch

export async function getSponsors(db: DB, opts: { showId?: string | null } = {}) {
  const where =
    opts.showId === undefined
      ? eq(sponsors.isActive, true)
      : and(eq(sponsors.isActive, true),
          opts.showId === null
            ? sql`${sponsors.showId} IS NULL`
            : eq(sponsors.showId, opts.showId));

  return db.select().from(sponsors).where(where).orderBy(asc(sponsors.tier));
}

export async function getSpiritWear(db: DB) {
  return db
    .select()
    .from(spiritWear)
    .where(eq(spiritWear.isAvailable, true))
    .orderBy(desc(spiritWear.isFeatured), asc(spiritWear.name));
}
