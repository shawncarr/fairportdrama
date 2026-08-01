import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '~/db/queries';
import { sponsors, spiritWear, SPONSOR_TIER } from '~/db/schema/content';
import { APP_ROLE } from '~/db/schema/governance';
import { get, post, resetTables, signIn } from '~/test/session';

const db = () => getDb(env.DB);

/** A genuine 1x1 GIF, so the upload byte sniffer sees a real image. */
const GIF_BYTES = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
  0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

const gif = (name = 'logo.gif') => new File([GIF_BYTES as BufferSource], name, { type: 'image/gif' });

const sponsorForm = (over: Record<string, string | File> = {}) => {
  const form = new FormData();
  form.set('name', 'Fairport Hardware');
  form.set('website', 'https://example.com');
  form.set('tier', SPONSOR_TIER.Gold);
  form.set('showId', '');
  form.set('isActive', '1');
  for (const [k, v] of Object.entries(over)) form.set(k, v);
  return form;
};

const itemForm = (over: Record<string, string | File> = {}) => {
  const form = new FormData();
  form.set('name', 'Drama Club Hoodie');
  form.set('description', 'Heavyweight, navy.');
  form.set('price', '35.00');
  form.set('category', 'apparel');
  form.set('sizes', 'S, M, L');
  form.set('colors', 'Navy');
  form.set('isAvailable', '1');
  for (const [k, v] of Object.entries(over)) form.set(k, v);
  return form;
};

beforeEach(async () => {
  await resetTables(['sponsors', 'spirit_wear', 'show_cast', 'show_crew', 'shows']);
});

describe('sponsor editor', () => {
  it('creates a sponsor from the form', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const response = await post('/admin/sponsors', cookie, sponsorForm());
    expect(response.status).toBe(302);

    const [row] = await db().select().from(sponsors);
    expect(row!.name).toBe('Fairport Hardware');
    expect(row!.tier).toBe(SPONSOR_TIER.Gold);
    expect(row!.isActive).toBe(true);
  });

  it('stores an uploaded logo and serves it back', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post('/admin/sponsors', cookie, sponsorForm({ logo: gif() }));

    const [row] = await db().select().from(sponsors);
    expect(row!.logoImageId).toBeTruthy();

    const image = await get(`/dev/images/${row!.logoImageId}/thumb`);
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(GIF_BYTES);
  });

  it('unticking "show on the site" deactivates rather than deletes', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post('/admin/sponsors', cookie, sponsorForm());
    const [created] = await db().select().from(sponsors);

    // isActive is a checkbox, so an unticked box submits nothing at all.
    const form = sponsorForm();
    form.delete('isActive');
    await post(`/admin/sponsors/${created!.id}`, cookie, form);

    const [row] = await db().select().from(sponsors);
    expect(row!.isActive).toBe(false);
    expect(await db().select().from(sponsors)).toHaveLength(1);
  });

  it('rejects a nameless sponsor without creating a row', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const response = await post('/admin/sponsors', cookie, sponsorForm({ name: '  ' }));
    expect(response.headers.get('location')).toContain('error=');
    expect(await db().select().from(sponsors)).toHaveLength(0);
  });

  it('removes a sponsor through its delete route', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post('/admin/sponsors', cookie, sponsorForm());
    const [created] = await db().select().from(sponsors);

    await post(`/admin/sponsors/${created!.id}/delete`, cookie, new FormData());
    expect(await db().select().from(sponsors)).toHaveLength(0);
  });
});

describe('spirit wear editor', () => {
  it('creates an item, parsing price and lists', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post('/admin/spiritwear', cookie, itemForm());

    const [row] = await db().select().from(spiritWear);
    expect(row!.priceCents).toBe(3500);
    expect(row!.sizes).toEqual(['S', 'M', 'L']);
    expect(row!.colors).toEqual(['Navy']);
    expect(row!.isFeatured).toBe(false);
  });

  it('refuses a price it cannot parse rather than storing zero', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const response = await post('/admin/spiritwear', cookie, itemForm({ price: 'twenty' }));
    expect(response.headers.get('location')).toContain('error=');
    // The critical assertion: no item priced at $0.00 reached the public site.
    expect(await db().select().from(spiritWear)).toHaveLength(0);
  });
});

describe('who can manage the catalog', () => {
  it('lets staff in', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);
    expect((await get('/admin/sponsors', cookie)).status).toBe(200);
    expect((await get('/admin/spiritwear', cookie)).status).toBe(200);
  });

  it('refuses an officer', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);
    expect((await get('/admin/sponsors', cookie)).status).toBe(403);
    expect((await get('/admin/spiritwear', cookie)).status).toBe(403);
  });

  it('refuses an officer the write routes too, not just the pages', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);
    expect((await post('/admin/sponsors', cookie, sponsorForm())).status).toBe(403);
    expect((await post('/admin/spiritwear', cookie, itemForm())).status).toBe(403);
    expect(await db().select().from(sponsors)).toHaveLength(0);
  });

  it('shows the nav links only to those who can use them', async () => {
    const staff = await signIn('director@example.com', APP_ROLE.Staff);
    const staffBody = await (await get('/admin', staff)).text();
    expect(staffBody).toContain('href="/admin/sponsors"');
    expect(staffBody).toContain('href="/admin/spiritwear"');

    const officer = await signIn('officer2@example.com', APP_ROLE.Officer);
    const officerBody = await (await get('/admin', officer)).text();
    expect(officerBody).not.toContain('href="/admin/sponsors"');
    expect(officerBody).not.toContain('href="/admin/spiritwear"');
  });
});
