import { eq, sql } from 'drizzle-orm';
import type { DB } from '~/db/queries';
import { showGalleryImages, shows } from '~/db/schema/content';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { writeWithAudit } from '~/lib/audit/write';
import type { Actor } from '~/lib/audit/actor';
import { generateId } from '~/lib/id';

/**
 * Production photos for a show.
 *
 * Publishing these is gated on `show.update` (Admin and Staff), not on
 * `cast.assign`, so student officers cannot put faces on the public site. The
 * acknowledgement the route requires is the actual control: nothing here can
 * verify that a photo release exists, and "only photos where everyone shown
 * has opted in" is not enforceable without tagging faces - which is exactly
 * the association the visibility system exists to prevent.
 *
 * The table's `caption` column is left unused by design. See the schema.
 */

/** Appends photos to the end of a show's gallery. */
export async function addGalleryImages(
  db: DB,
  actor: Actor,
  showId: string,
  imageIds: string[],
): Promise<{ added: number }> {
  if (imageIds.length === 0) return { added: 0 };

  const [show] = await db.select().from(shows).where(eq(shows.id, showId)).limit(1);
  if (!show) throw new Error(`Unknown show: ${showId}`);

  // Continue after the highest existing position rather than counting rows,
  // so removing a photo from the middle cannot make two rows collide.
  const [last] = await db
    .select({ max: sql<number | null>`MAX(${showGalleryImages.sortOrder})` })
    .from(showGalleryImages)
    .where(eq(showGalleryImages.showId, showId));
  let next = (last?.max ?? -1) + 1;

  const rows = imageIds.map((imageId) => ({
    id: generateId(),
    showId,
    imageId,
    sortOrder: next++,
  }));

  await writeWithAudit(db, actor, [db.insert(showGalleryImages).values(rows)], {
    action: AUDIT_ACTION.ShowGalleryChanged,
    targetKind: AUDIT_ENTITY_KIND.Show,
    targetId: showId,
    // Photos of minors go public here, so the row records how many and which,
    // not merely that "the gallery changed".
    payload: { added: rows.length, imageIds },
  });

  return { added: rows.length };
}

export async function removeGalleryImage(
  db: DB,
  actor: Actor,
  showId: string,
  galleryId: string,
): Promise<{ removed: boolean }> {
  const [row] = await db
    .select()
    .from(showGalleryImages)
    .where(eq(showGalleryImages.id, galleryId))
    .limit(1);

  // Checked against the show in the URL so a stale form cannot delete a photo
  // from a different production.
  if (!row || row.showId !== showId) return { removed: false };

  await writeWithAudit(
    db,
    actor,
    [db.delete(showGalleryImages).where(eq(showGalleryImages.id, galleryId))],
    {
      action: AUDIT_ACTION.ShowGalleryChanged,
      targetKind: AUDIT_ENTITY_KIND.Show,
      targetId: showId,
      // Taking a photo down is the action most likely to be asked about after
      // the fact ("did someone remove my photo when I asked?"), so the image
      // id stays on the row even though the row it described is gone.
      payload: { removed: true, imageId: row.imageId },
    },
  );

  return { removed: true };
}
