import { asc, eq, ne, sql } from 'drizzle-orm';
import type { DB } from '~/db/queries';
import {
  showCast,
  showCrew,
  showGalleryImages,
  showPerformances,
  shows,
} from '~/db/schema/content';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { buildDiff, isEmptyDiff } from '~/lib/audit/diff';
import { writeWithAudit } from '~/lib/audit/write';
import type { Actor } from '~/lib/audit/actor';
import { generateId } from '~/lib/id';
import { slugify } from './news';

export const DEFAULT_VENUE = 'Fairport High School Auditorium';

export interface ShowInput {
  title: string;
  season: string;
  year: number;
  venue: string;
  synopsis: string;
  ticketUrl: string | null;
  isHighlighted: boolean;
}

export type CreateShowResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Adds a production.
 *
 * The id is `title-year`, matching the ids migrated from the Astro site, and
 * is never regenerated on edit: it is the public URL, and changing it would
 * break every link already shared for a show that is selling tickets.
 *
 * A new show is not featured. Creating the record and announcing it are
 * separate decisions - a spring show often exists in the admin weeks before
 * anyone wants it on the homepage.
 */
export async function createShow(
  db: DB,
  actor: Actor,
  input: ShowInput,
): Promise<CreateShowResult> {
  const title = input.title.trim().replace(/\s+/g, ' ');
  if (title.length === 0) return { ok: false, error: 'A show needs a title.' };

  const base = slugify(title);
  if (base.length === 0) {
    return { ok: false, error: 'That title cannot be turned into a web address.' };
  }

  const id = await freeId(db, `${base}-${input.year}`);

  await writeWithAudit(
    db,
    actor,
    [
      db.insert(shows).values({
        id,
        title,
        season: input.season.trim(),
        year: input.year,
        venue: input.venue.trim() || DEFAULT_VENUE,
        synopsis: input.synopsis.trim(),
        ticketUrl: input.ticketUrl,
        isCurrent: false,
        isHighlighted: input.isHighlighted,
      }),
    ],
    {
      action: AUDIT_ACTION.ShowCreated,
      targetKind: AUDIT_ENTITY_KIND.Show,
      targetId: id,
      payload: { title, season: input.season, year: input.year },
    },
  );

  return { ok: true, id };
}

/** A show restaged in the same year gets a suffix rather than colliding. */
async function freeId(db: DB, base: string): Promise<string> {
  for (let n = 1; n < 50; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const rows = await db
      .select({ id: shows.id })
      .from(shows)
      .where(eq(shows.id, candidate))
      .limit(1);
    if (rows.length === 0) return candidate;
  }
  throw new Error(`No free id for ${base}`);
}

export async function updateShow(
  db: DB,
  actor: Actor,
  id: string,
  patch: Partial<ShowInput>,
): Promise<{ updated: boolean }> {
  const [current] = await db.select().from(shows).where(eq(shows.id, id)).limit(1);
  if (!current) return { updated: false };

  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if ((current as Record<string, unknown>)[key] === value) continue;
    set[key] = value;
  }
  if (Object.keys(set).length === 0) return { updated: false };

  const diff = buildDiff(
    current as Record<string, unknown>,
    { ...current, ...set } as Record<string, unknown>,
    set,
  );
  if (isEmptyDiff(diff)) return { updated: false };

  await writeWithAudit(
    db,
    actor,
    [
      db
        .update(shows)
        .set({ ...set, updatedAt: new Date().toISOString() })
        .where(eq(shows.id, id)),
    ],
    {
      action: AUDIT_ACTION.ShowUpdated,
      targetKind: AUDIT_ENTITY_KIND.Show,
      targetId: id,
      diff,
    },
  );

  return { updated: true };
}

/**
 * Makes one show the featured production, or clears the feature entirely.
 *
 * Exclusive by construction. `getCurrentShow` selects the flagged row with
 * `limit(1)` and no ordering, so two shows flagged at once would leave the
 * homepage picking one arbitrarily - a state the admin could otherwise reach
 * with two clicks.
 */
export async function setFeaturedShow(
  db: DB,
  actor: Actor,
  id: string | null,
): Promise<{ changed: boolean }> {
  const [previous] = await db
    .select({ id: shows.id })
    .from(shows)
    .where(eq(shows.isCurrent, true))
    .limit(1);

  if ((previous?.id ?? null) === id) return { changed: false };

  const writes = [];
  if (previous) {
    writes.push(
      db
        .update(shows)
        .set({ isCurrent: false, updatedAt: new Date().toISOString() })
        .where(ne(shows.id, id ?? '')),
    );
  }
  if (id) {
    writes.push(
      db
        .update(shows)
        .set({ isCurrent: true, updatedAt: new Date().toISOString() })
        .where(eq(shows.id, id)),
    );
  }
  if (writes.length === 0) return { changed: false };

  await writeWithAudit(db, actor, writes as never, {
    action: AUDIT_ACTION.ShowUpdated,
    targetKind: AUDIT_ENTITY_KIND.Show,
    targetId: id ?? (previous?.id as string),
    // Keyed as `featuredShow` rather than `isCurrent`: the values are show
    // ids, not the booleans that column holds, and a diff that lies about
    // what it is describing is worse than no diff.
    diff: { featuredShow: { before: previous?.id ?? null, after: id } },
    payload: { featured: true },
    relatedEntities: previous ? [{ kind: AUDIT_ENTITY_KIND.Show, id: previous.id }] : [],
  });

  return { changed: true };
}

export interface PerformanceRow {
  date: string;
  time: string;
}

/**
 * Replaces a show's performance schedule.
 *
 * Submitted whole, like the cast list: a run is decided as a set, and these
 * dates determine whether the site presents the show as upcoming or over.
 */
export async function replacePerformances(
  db: DB,
  actor: Actor,
  showId: string,
  rows: PerformanceRow[],
): Promise<{ changed: boolean }> {
  const [show] = await db.select().from(shows).where(eq(shows.id, showId)).limit(1);
  if (!show) return { changed: false };

  const before = await db
    .select()
    .from(showPerformances)
    .where(eq(showPerformances.showId, showId))
    .orderBy(asc(showPerformances.date));

  const clean = rows
    .map((r) => ({ date: r.date.trim(), time: r.time.trim() }))
    // A row needs a date to mean anything; the time is a display string and
    // may legitimately be left for later.
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)));

  const key = (r: { date: string; time: string }) => `${r.date} ${r.time}`;
  const beforeKeys = before.map(key);
  const afterKeys = clean.map(key);
  if (beforeKeys.length === afterKeys.length && beforeKeys.every((k, i) => k === afterKeys[i])) {
    return { changed: false };
  }

  await writeWithAudit(
    db,
    actor,
    [
      db.delete(showPerformances).where(eq(showPerformances.showId, showId)),
      ...clean.map((r) =>
        db.insert(showPerformances).values({
          id: generateId(),
          showId,
          date: r.date,
          time: r.time,
        }),
      ),
    ] as never,
    {
      action: AUDIT_ACTION.ShowPerformancesChanged,
      targetKind: AUDIT_ENTITY_KIND.Show,
      targetId: showId,
      diff: { performances: { before: beforeKeys, after: afterKeys } },
    },
  );

  return { changed: true };
}

export type DeleteShowResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Deletes a show, but only while nothing about the production has been
 * recorded yet.
 *
 * Cast, crew, and gallery rows all cascade, so deleting an established show
 * would erase the record of who performed in it - and for a past production
 * the printed playbill is the only other copy. Refusing keeps that possible
 * while still allowing a show typed in by mistake to be cleaned up.
 */
export async function deleteShow(
  db: DB,
  actor: Actor,
  id: string,
): Promise<DeleteShowResult> {
  const [current] = await db.select().from(shows).where(eq(shows.id, id)).limit(1);
  if (!current) return { ok: false, error: 'That show does not exist.' };

  const [counts] = await db
    .select({
      cast: sql<number>`(SELECT COUNT(*) FROM show_cast WHERE show_id = ${id})`,
      crew: sql<number>`(SELECT COUNT(*) FROM show_crew WHERE show_id = ${id})`,
      gallery: sql<number>`(SELECT COUNT(*) FROM show_gallery_images WHERE show_id = ${id})`,
    })
    .from(shows)
    .where(eq(shows.id, id));

  const attached =
    (counts?.cast ?? 0) + (counts?.crew ?? 0) + (counts?.gallery ?? 0);
  if (attached > 0) {
    return {
      ok: false,
      error:
        'This show has cast, crew, or photos recorded against it. Deleting it would erase who performed in it. Remove those first if you really mean to delete it.',
    };
  }

  await writeWithAudit(
    db,
    actor,
    [
      db.delete(showPerformances).where(eq(showPerformances.showId, id)),
      db.delete(shows).where(eq(shows.id, id)),
    ] as never,
    {
      action: AUDIT_ACTION.ShowDeleted,
      targetKind: AUDIT_ENTITY_KIND.Show,
      targetId: id,
      // Kept because a deleted row cannot be joined against afterwards.
      payload: { title: current.title, season: current.season, year: current.year },
    },
  );

  return { ok: true };
}

/** Row counts that decide whether a show may still be deleted. */
export async function showIsDeletable(db: DB, id: string): Promise<boolean> {
  const [row] = await db
    .select({
      n: sql<number>`(
        (SELECT COUNT(*) FROM show_cast WHERE show_id = ${id})
        + (SELECT COUNT(*) FROM show_crew WHERE show_id = ${id})
        + (SELECT COUNT(*) FROM show_gallery_images WHERE show_id = ${id})
      )`,
    })
    .from(shows)
    .where(eq(shows.id, id));
  return (row?.n ?? 1) === 0;
}
