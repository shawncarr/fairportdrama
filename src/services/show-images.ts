import { eq } from 'drizzle-orm';
import type { DB } from '~/db/queries';
import { shows } from '~/db/schema/content';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { buildDiff, isEmptyDiff } from '~/lib/audit/diff';
import { writeWithAudit } from '~/lib/audit/write';
import type { Actor } from '~/lib/audit/actor';

export interface ShowImagePatch {
  posterImageId?: string | null;
  heroImageId?: string | null;
  ogImageId?: string | null;
}

/**
 * Sets a show's artwork.
 *
 * Unlike a member photo this applies immediately: show artwork is club
 * material rather than anything about an identifiable student, and the roles
 * that can reach this route already publish directly.
 *
 * The previous image is not deleted from the store. A replaced poster may
 * still be referenced by a cached page or an already-sent social preview, and
 * the storage cost of keeping it is a fraction of a cent. Reclaiming orphans
 * is a sweep to run later against ids no row references, not something to do
 * inline where a mistake deletes a live image.
 */
export async function updateShowImages(
  db: DB,
  actor: Actor,
  showId: string,
  patch: ShowImagePatch,
): Promise<{ changed: boolean }> {
  const [current] = await db.select().from(shows).where(eq(shows.id, showId)).limit(1);
  if (!current) throw new Error(`Unknown show: ${showId}`);

  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if ((current as Record<string, unknown>)[key] === value) continue;
    set[key] = value;
  }

  if (Object.keys(set).length === 0) return { changed: false };

  const diff = buildDiff(
    current as Record<string, unknown>,
    { ...current, ...set } as Record<string, unknown>,
    set,
  );
  if (isEmptyDiff(diff)) return { changed: false };

  await writeWithAudit(
    db,
    actor,
    [
      db
        .update(shows)
        .set({ ...set, updatedAt: new Date().toISOString() })
        .where(eq(shows.id, showId)),
    ],
    {
      action: AUDIT_ACTION.ShowUpdated,
      targetKind: AUDIT_ENTITY_KIND.Show,
      targetId: showId,
      diff,
    },
  );

  return { changed: true };
}
