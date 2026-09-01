import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import {
  members,
  showGalleryImages,
  showPerformances,
  shows,
  MEMBER_VISIBILITY,
} from '~/db/schema/content';
import { pendingEdits, APP_ROLE } from '~/db/schema/governance';
import { get, post, resetTables, signIn } from '~/test/session';

/**
 * The upload path, end to end through a real session.
 *
 * The unit tests cover validation in isolation; this covers the parts only a
 * real request exercises - multipart parsing, the store write, and whether the
 * stored bytes actually come back out of the delivery URL.
 */

const db = () => getDb(env.DB);

/** A minimal but genuine 1x1 GIF, so the byte sniffer sees a real image. */
const GIF_BYTES = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
  0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

const imageFile = (data: Uint8Array, name = 'photo.gif', type = 'image/gif') =>
  new File([data as BufferSource], name, { type });

/** The profile form as a browser submits it: every field present. */
const profileForm = (over: Record<string, string | File> = {}) => {
  const form = new FormData();
  form.set('visibility', MEMBER_VISIBILITY.Limited);
  form.set('bio', 'Original bio.');
  form.set('instagram', '');
  for (const [k, v] of Object.entries(over)) form.set(k, v);
  return form;
};

beforeEach(async () => {
  await resetTables([
    'show_cast',
    'show_crew',
    'show_gallery_images',
    'show_performances',
    'shows',
    'members',
  ]);

  await db().insert(members).values({
    id: 'daniel-doser',
    name: 'Daniel Doser',
    grade: 'Senior',
    visibility: MEMBER_VISIBILITY.Limited,
    bio: 'Original bio.',
  });

  await db().insert(shows).values({
    id: 'charlottes-web',
    title: "Charlotte's Web",
    season: 'Fall 2025',
    year: 2025,
    synopsis: 'A pig and a spider.',
  });
  // Its real run, so the show is a closed production with a public page.
  // Left dateless and unannounced it is a draft, and /shows/:slug 404s a
  // draft for anyone without show:update - which is what a gallery test
  // fetching the page anonymously would hit.
  await db()
    .insert(showPerformances)
    .values([
      { id: 'cw-p1', showId: 'charlottes-web', date: '2025-11-14', time: '7:00 PM' },
      { id: 'cw-p2', showId: 'charlottes-web', date: '2025-11-15', time: '2:00 PM' },
    ]);
});

const member = async () =>
  (await db().select().from(members).where(eq(members.id, 'daniel-doser')))[0]!;

describe('a member uploading their own photo', () => {
  it('queues the photo for approval instead of publishing it', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');

    const response = await post(
      '/admin/profile',
      cookie,
      profileForm({ photo: imageFile(GIF_BYTES) }),
    );
    expect(response.status).toBe(302);

    // The live record is untouched...
    expect((await member()).photoImageId).toBeNull();

    // ...but the image itself was stored and is named on the pending edit.
    const [queued] = await db().select().from(pendingEdits);
    const proposed = queued!.proposed as Record<string, unknown>;
    expect(typeof proposed.photoImageId).toBe('string');
  });

  it('serves the stored bytes back from the delivery URL', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    await post('/admin/profile', cookie, profileForm({ photo: imageFile(GIF_BYTES) }));

    const [queued] = await db().select().from(pendingEdits);
    const imageId = (queued!.proposed as Record<string, string>).photoImageId!;

    // Proves the round trip: what the form uploaded is what the store returns,
    // byte for byte, under the content type the sniffer decided on.
    const response = await get(`/dev/images/${imageId}/thumb`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/gif');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(GIF_BYTES);
  });

  it('rejects a non-image without storing anything', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    const evil = new TextEncoder().encode('<svg onload="alert(1)"><script/></svg>');

    const response = await post(
      '/admin/profile',
      cookie,
      profileForm({ photo: imageFile(evil, 'photo.gif', 'image/gif') }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('error=');
    expect(await db().select().from(pendingEdits)).toHaveLength(0);
  });

  it('leaves the existing photo alone when no file is chosen', async () => {
    await db()
      .update(members)
      .set({ photoImageId: 'existing-image' })
      .where(eq(members.id, 'daniel-doser'));

    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    // An untouched file input submits a zero-byte entry, exactly as here.
    await post('/admin/profile', cookie, profileForm({ photo: imageFile(new Uint8Array(0)) }));

    expect((await member()).photoImageId).toBe('existing-image');
    expect(await db().select().from(pendingEdits)).toHaveLength(0);
  });

  it('takes the photo down immediately when asked to remove it', async () => {
    await db()
      .update(members)
      .set({ photoImageId: 'existing-image' })
      .where(eq(members.id, 'daniel-doser'));

    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    await post('/admin/profile', cookie, profileForm({ removePhoto: '1' }));

    expect((await member()).photoImageId).toBeNull();
    expect(await db().select().from(pendingEdits)).toHaveLength(0);
  });
});

describe('show artwork', () => {
  it('is applied at once by staff', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff, null);

    const form = new FormData();
    form.set('posterImageId', imageFile(GIF_BYTES, 'poster.gif'));
    const response = await post('/admin/shows/charlottes-web/images', cookie, form);
    expect(response.status).toBe(302);

    const [row] = await db().select().from(shows).where(eq(shows.id, 'charlottes-web'));
    expect(row!.posterImageId).toBeTruthy();
  });

  it('is refused to an officer, who cannot edit shows', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer, 'daniel-doser');

    const form = new FormData();
    form.set('posterImageId', imageFile(GIF_BYTES, 'poster.gif'));
    expect((await post('/admin/shows/charlottes-web/images', cookie, form)).status).toBe(403);
  });

  it('is not offered to an officer in the first place', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer, 'daniel-doser');
    const body = await (await get('/admin/shows/charlottes-web', cookie)).text();

    // The page is reachable with cast.assign, so the form must be withheld
    // rather than shown and then 403ing on submit.
    expect(body).toContain('Cast');
    expect(body).not.toContain('/images');
  });
});

describe('show gallery', () => {
  const galleryForm = (files: File[], acknowledged = true) => {
    const form = new FormData();
    for (const f of files) form.append('photos', f);
    if (acknowledged) form.set('acknowledged', '1');
    return form;
  };

  const photos = () => db().select().from(showGalleryImages);

  it('uploads several photos in one submission', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);

    const response = await post(
      '/admin/shows/charlottes-web/gallery',
      cookie,
      galleryForm([imageFile(GIF_BYTES, 'a.gif'), imageFile(GIF_BYTES, 'b.gif')]),
    );
    expect(response.status).toBe(302);
    expect(await photos()).toHaveLength(2);
  });

  it('publishes nothing without the permission acknowledgement', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);

    // The checkbox is marked required in the markup, but that is not a
    // control - it is the only thing standing between a photo of a student
    // and the public site, so the server has to enforce it.
    const response = await post(
      '/admin/shows/charlottes-web/gallery',
      cookie,
      galleryForm([imageFile(GIF_BYTES, 'a.gif')], false),
    );
    expect(response.headers.get('location')).toContain('error=');
    expect(await photos()).toHaveLength(0);
  });

  it('rejects the batch if any file is not an image', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);
    const evil = new TextEncoder().encode('<svg onload="alert(1)"><script/></svg>');

    const response = await post(
      '/admin/shows/charlottes-web/gallery',
      cookie,
      galleryForm([imageFile(GIF_BYTES, 'a.gif'), imageFile(evil, 'b.gif')]),
    );
    expect(response.headers.get('location')).toContain('error=');
    expect(await photos()).toHaveLength(0);
  });

  it('is refused to an officer, who cannot publish photos of students', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer, 'daniel-doser');

    const response = await post(
      '/admin/shows/charlottes-web/gallery',
      cookie,
      galleryForm([imageFile(GIF_BYTES, 'a.gif')]),
    );
    expect(response.status).toBe(403);
    expect(await photos()).toHaveLength(0);
  });

  it('serves an uploaded gallery photo and shows it on the public page', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);
    await post(
      '/admin/shows/charlottes-web/gallery',
      cookie,
      galleryForm([imageFile(GIF_BYTES, 'a.gif')]),
    );

    const [row] = await photos();
    const image = await get(`/dev/images/${row!.imageId}/gallery`);
    expect(image.status).toBe(200);

    const page = await (await get('/shows/charlottes-web')).text();
    expect(page).toContain('Gallery');
    // Alt text is generated, never a caption or a name.
    expect(page).toContain("Charlotte&#39;s Web production photo 1 of 1");
  });

  it('removes a photo through its delete route', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);
    await post(
      '/admin/shows/charlottes-web/gallery',
      cookie,
      galleryForm([imageFile(GIF_BYTES, 'a.gif')]),
    );
    const [row] = await photos();

    await post(
      `/admin/shows/charlottes-web/gallery/${row!.id}/delete`,
      cookie,
      new FormData(),
    );
    expect(await photos()).toHaveLength(0);
  });
});
