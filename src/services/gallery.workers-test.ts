import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import { showGalleryImages, shows } from '~/db/schema/content';
import { auditEvents } from '~/db/schema/governance';
import { AUDIT_ACTOR_KIND, type Actor } from '~/lib/audit/actor';
import { AUDIT_ACTION } from '~/lib/audit/constants';
import { addGalleryImages, removeGalleryImage } from './gallery';

const db = () => getDb(env.DB);

const staff: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'user_staff',
  label: 'Director',
  ip: '203.0.113.40',
  userAgent: 'Firefox',
};

const gallery = (showId = 'charlottes-web') =>
  db()
    .select()
    .from(showGalleryImages)
    .where(eq(showGalleryImages.showId, showId))
    .orderBy(asc(showGalleryImages.sortOrder));

const audits = async () => db().select().from(auditEvents);

beforeEach(async () => {
  await env.DB.exec('DELETE FROM audit_events');
  await env.DB.exec('DELETE FROM show_gallery_images');
  await env.DB.exec('DELETE FROM shows');

  await db().insert(shows).values([
    {
      id: 'charlottes-web',
      title: "Charlotte's Web",
      season: 'Fall 2025',
      year: 2025,
      synopsis: 'A pig and a spider.',
    },
    {
      id: 'hadestown',
      title: 'Hadestown',
      season: 'Spring 2025',
      year: 2025,
      synopsis: 'Way down under.',
    },
  ]);
});

describe('adding photos', () => {
  it('appends in the order given', async () => {
    await addGalleryImages(db(), staff, 'charlottes-web', ['img-a', 'img-b', 'img-c']);

    const rows = await gallery();
    expect(rows.map((r) => r.imageId)).toEqual(['img-a', 'img-b', 'img-c']);
    expect(rows.map((r) => r.sortOrder)).toEqual([0, 1, 2]);
  });

  it('continues after existing photos rather than restarting at zero', async () => {
    await addGalleryImages(db(), staff, 'charlottes-web', ['img-a', 'img-b']);
    await addGalleryImages(db(), staff, 'charlottes-web', ['img-c']);

    const rows = await gallery();
    expect(rows.map((r) => r.imageId)).toEqual(['img-a', 'img-b', 'img-c']);
    expect(rows.map((r) => r.sortOrder)).toEqual([0, 1, 2]);
  });

  it('does not collide after a photo is removed from the middle', async () => {
    await addGalleryImages(db(), staff, 'charlottes-web', ['img-a', 'img-b', 'img-c']);
    const rows = await gallery();
    await removeGalleryImage(db(), staff, 'charlottes-web', rows[1]!.id);

    await addGalleryImages(db(), staff, 'charlottes-web', ['img-d']);

    // Counting rows instead of taking MAX would reuse position 2 here and give
    // two photos the same sort order.
    const after = await gallery();
    expect(after.map((r) => r.sortOrder)).toEqual([0, 2, 3]);
    expect(new Set(after.map((r) => r.sortOrder)).size).toBe(after.length);
  });

  it('records which images were published, not just that something changed', async () => {
    await addGalleryImages(db(), staff, 'charlottes-web', ['img-a', 'img-b']);

    const [audit] = await audits();
    expect(audit!.action).toBe(AUDIT_ACTION.ShowGalleryChanged);
    expect(audit!.actorUserId).toBe('user_staff');
    expect(audit!.payload).toMatchObject({ added: 2, imageIds: ['img-a', 'img-b'] });
  });

  it('writes nothing for an empty batch', async () => {
    const result = await addGalleryImages(db(), staff, 'charlottes-web', []);
    expect(result.added).toBe(0);
    expect(await audits()).toHaveLength(0);
  });

  it('rejects an unknown show', async () => {
    await expect(
      addGalleryImages(db(), staff, 'no-such-show', ['img-a']),
    ).rejects.toThrow('Unknown show');
  });
});

describe('removing photos', () => {
  it('deletes the row and keeps the image id on the audit trail', async () => {
    await addGalleryImages(db(), staff, 'charlottes-web', ['img-a']);
    await env.DB.exec('DELETE FROM audit_events');
    const [row] = await gallery();

    expect((await removeGalleryImage(db(), staff, 'charlottes-web', row!.id)).removed).toBe(
      true,
    );
    expect(await gallery()).toHaveLength(0);

    // "Did someone take my photo down when I asked?" is answerable only if the
    // image id survives the row it described.
    const [audit] = await audits();
    expect(audit!.payload).toMatchObject({ removed: true, imageId: 'img-a' });
  });

  it('refuses to delete a photo belonging to a different show', async () => {
    await addGalleryImages(db(), staff, 'hadestown', ['img-x']);
    const [other] = await gallery('hadestown');

    // The show id comes from the URL; the photo id from the form. A mismatched
    // pair must not delete anything.
    const result = await removeGalleryImage(db(), staff, 'charlottes-web', other!.id);
    expect(result.removed).toBe(false);
    expect(await gallery('hadestown')).toHaveLength(1);
  });

  it('ignores an unknown photo id', async () => {
    expect((await removeGalleryImage(db(), staff, 'charlottes-web', 'nope')).removed).toBe(
      false,
    );
  });
});

describe('deleting a show', () => {
  it('takes its gallery with it', async () => {
    await addGalleryImages(db(), staff, 'charlottes-web', ['img-a', 'img-b']);
    await db().delete(shows).where(eq(shows.id, 'charlottes-web'));

    // The FK cascades, so photos cannot outlive the show and linger as
    // published images nothing points at.
    expect(await gallery()).toHaveLength(0);
  });
});
