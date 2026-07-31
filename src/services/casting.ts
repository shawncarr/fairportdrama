import { asc, eq } from 'drizzle-orm';
import type { DB } from '~/db/queries';
import { showCast, showCrew, shows, type ShowCastTier } from '~/db/schema/content';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { writeWithAudit } from '~/lib/audit/write';
import type { Actor } from '~/lib/audit/actor';
import { generateId } from '~/lib/id';

export interface CastRow {
  id?: string;
  role: string;
  memberId: string | null;
  tier: ShowCastTier;
  additionalRoles: string[];
}

export interface CrewRow {
  id?: string;
  role: string;
  memberId: string | null;
}

/**
 * Replaces a show's cast list.
 *
 * The whole list is submitted at once because casting is decided as a set -
 * roles get reassigned between people in a single sitting, and applying those
 * one at a time would transiently violate nothing but would produce a stream
 * of audit rows that hide the actual decision.
 *
 * A single audit row records the resulting assignment, with a diff of the
 * roles whose casting actually changed.
 */
export async function replaceCast(
  db: DB,
  actor: Actor,
  showId: string,
  rows: CastRow[],
): Promise<{ changed: boolean }> {
  const [show] = await db.select().from(shows).where(eq(shows.id, showId)).limit(1);
  if (!show) return { changed: false };

  const before = await db
    .select()
    .from(showCast)
    .where(eq(showCast.showId, showId))
    .orderBy(asc(showCast.sortOrder));

  const clean = rows
    .map((r) => ({ ...r, role: r.role.trim() }))
    .filter((r) => r.role.length > 0);

  const diff = castDiff(before, clean);
  if (Object.keys(diff).length === 0) return { changed: false };

  await writeWithAudit(
    db,
    actor,
    [
      db.delete(showCast).where(eq(showCast.showId, showId)),
      ...clean.map((r, i) =>
        db.insert(showCast).values({
          id: generateId(),
          showId,
          memberId: r.memberId,
          role: r.role,
          additionalRoles: r.additionalRoles,
          tier: r.tier,
          sortOrder: i,
        }),
      ),
    ] as never,
    {
      action: AUDIT_ACTION.ShowCastAssigned,
      targetKind: AUDIT_ENTITY_KIND.Show,
      targetId: showId,
      diff,
      relatedEntities: clean
        .filter((r) => r.memberId)
        .map((r) => ({ kind: AUDIT_ENTITY_KIND.Member, id: r.memberId! })),
    },
  );

  return { changed: true };
}

export async function replaceCrew(
  db: DB,
  actor: Actor,
  showId: string,
  rows: CrewRow[],
): Promise<{ changed: boolean }> {
  const [show] = await db.select().from(shows).where(eq(shows.id, showId)).limit(1);
  if (!show) return { changed: false };

  const before = await db
    .select()
    .from(showCrew)
    .where(eq(showCrew.showId, showId))
    .orderBy(asc(showCrew.sortOrder));

  const clean = rows
    .map((r) => ({ ...r, role: r.role.trim() }))
    .filter((r) => r.role.length > 0);

  const diff = crewDiff(before, clean);
  if (Object.keys(diff).length === 0) return { changed: false };

  await writeWithAudit(
    db,
    actor,
    [
      db.delete(showCrew).where(eq(showCrew.showId, showId)),
      ...clean.map((r, i) =>
        db.insert(showCrew).values({
          id: generateId(),
          showId,
          memberId: r.memberId,
          role: r.role,
          sortOrder: i,
        }),
      ),
    ] as never,
    {
      action: AUDIT_ACTION.ShowCrewAssigned,
      targetKind: AUDIT_ENTITY_KIND.Show,
      targetId: showId,
      diff,
      relatedEntities: clean
        .filter((r) => r.memberId)
        .map((r) => ({ kind: AUDIT_ENTITY_KIND.Member, id: r.memberId! })),
    },
  );

  return { changed: true };
}

/**
 * Diff keyed by role name rather than by row id.
 *
 * Rows are recreated on every save, so their ids are meaningless across saves.
 * What a reader of the log wants to know is "who is playing Percy now, and who
 * was before" - which is a question about the role, not the row.
 */
export function castDiff(
  before: { role: string; memberId: string | null; tier: string }[],
  after: { role: string; memberId: string | null; tier: string }[],
): Record<string, { before: unknown; after: unknown }> {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  const key = (r: { memberId: string | null; tier: string }) => ({
    memberId: r.memberId,
    tier: r.tier,
  });

  const beforeByRole = new Map(before.map((r) => [r.role, r]));
  const afterByRole = new Map(after.map((r) => [r.role, r]));

  for (const [role, next] of afterByRole) {
    const prev = beforeByRole.get(role);
    if (!prev) {
      diff[role] = { before: null, after: key(next) };
    } else if (prev.memberId !== next.memberId || prev.tier !== next.tier) {
      diff[role] = { before: key(prev), after: key(next) };
    }
  }

  for (const [role, prev] of beforeByRole) {
    if (!afterByRole.has(role)) diff[role] = { before: key(prev), after: null };
  }

  return diff;
}

export function crewDiff(
  before: { role: string; memberId: string | null }[],
  after: { role: string; memberId: string | null }[],
): Record<string, { before: unknown; after: unknown }> {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  const beforeByRole = new Map(before.map((r) => [r.role, r]));
  const afterByRole = new Map(after.map((r) => [r.role, r]));

  for (const [role, next] of afterByRole) {
    const prev = beforeByRole.get(role);
    if (!prev) diff[role] = { before: null, after: next.memberId };
    else if (prev.memberId !== next.memberId) {
      diff[role] = { before: prev.memberId, after: next.memberId };
    }
  }
  for (const [role, prev] of beforeByRole) {
    if (!afterByRole.has(role)) diff[role] = { before: prev.memberId, after: null };
  }
  return diff;
}
