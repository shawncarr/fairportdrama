import { Hono, type Context } from 'hono';
import { asc, eq } from 'drizzle-orm';
import type { AppEnv } from '~/env';
import { getDb } from '~/db/queries';
import {
  shows,
  sponsors,
  spiritWear,
  SPONSOR_TIER,
  SPIRIT_WEAR_CATEGORY,
} from '~/db/schema/content';
import { adminLayout } from '~/layouts/AdminLayout';
import { noStore, requirePermission } from '~/middleware/require';
import { IMAGE_VARIANT, MAX_IMAGE_BYTES, uploadImage, type ImageStore } from '~/lib/images';
import {
  SPIRIT_WEAR_CATEGORY_LABELS,
  SPONSOR_TIER_LABELS,
  createSponsor,
  createSpiritWear,
  deleteSponsor,
  deleteSpiritWear,
  isSponsorTier,
  isSpiritWearCategory,
  type SponsorInput,
  type SpiritWearInput,
  parseList,
  parsePriceCents,
  updateSponsor,
  updateSpiritWear,
} from '~/services/catalog';

/**
 * Sponsor and spirit wear management.
 *
 * Separate from admin.tsx, which is already long enough that finding anything
 * in it is work. Both editors follow the same shape: a list of rows, each its
 * own form, plus one blank form to add.
 */
export const adminCatalogRoutes = new Hono<AppEnv>();

adminCatalogRoutes.use('/admin/*', noStore);
adminCatalogRoutes.use('/admin/*', adminLayout);

const input =
  'w-full px-3 py-2 rounded-lg border border-neutral-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none text-sm';
const label = 'block text-xs font-medium text-neutral-600 mb-1';
const primaryButton =
  'px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-lg transition-colors';
const fileInput =
  'w-full text-xs text-neutral-600 file:mr-2 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-neutral-100 file:text-neutral-800 hover:file:bg-neutral-200';

/**
 * Delete is its own form posting to its own route, never a link.
 *
 * A GET that destroys data is followed by anything that prefetches, and the
 * confirm() is advisory only - the route does not depend on it.
 */
function DeleteButton({ action, name }: { action: string; name: string }) {
  return (
    <form
      method="post"
      action={action}
      onsubmit={`return confirm('Remove ${name.replace(/'/g, "\\'")}?')`}
    >
      <button
        type="submit"
        class="px-3 py-2 text-sm text-red-700 hover:bg-red-50 rounded-lg transition-colors"
      >
        Remove
      </button>
    </form>
  );
}

function ImageField({
  name,
  url,
  hint,
}: {
  name: string;
  url: string | null;
  hint: string;
}) {
  return (
    <div>
      <p class={label}>Image</p>
      <div class="flex items-start gap-3">
        {url ? (
          <img
            src={url}
            alt=""
            class="w-16 h-16 rounded object-contain bg-white ring-1 ring-neutral-200 shrink-0"
          />
        ) : (
          <div class="w-16 h-16 rounded bg-neutral-100 ring-1 ring-neutral-200 shrink-0 flex items-center justify-center text-[10px] text-neutral-400">
            None
          </div>
        )}
        <div class="flex-1">
          <input
            type="file"
            name={name}
            accept="image/jpeg,image/png,image/gif,image/webp"
            class={fileInput}
          />
          <p class="text-xs text-neutral-500 mt-1">{hint}</p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sponsors

adminCatalogRoutes.get(
  '/admin/sponsors',
  requirePermission('sponsor', 'manage'),
  async (c) => {
    const db = getDb(c.env.DB);
    const images = c.get('images');

    const [all, allShows] = await Promise.all([
      db.select().from(sponsors).orderBy(asc(sponsors.tier), asc(sponsors.name)),
      db.select({ id: shows.id, title: shows.title }).from(shows).orderBy(asc(shows.title)),
    ]);

    const error = c.req.query('error');

    return c.render(
      <div class="space-y-6 max-w-4xl">
        <h1 class="font-display text-2xl font-bold text-neutral-900">Sponsors</h1>

        {error && (
          <p class="rounded-lg bg-red-50 text-red-800 text-sm px-4 py-3 ring-1 ring-red-200">
            {error}
          </p>
        )}

        <p class="text-sm text-neutral-600">
          Sponsors appear on the sponsors page grouped by tier, and on the home page.
          Turning one off hides it everywhere without losing the record.
        </p>

        {all.map((s) => (
          <SponsorForm
            sponsor={s}
            shows={allShows}
            images={images}
            action={`/admin/sponsors/${s.id}`}
          />
        ))}

        <div>
          <h2 class="font-display font-semibold text-neutral-900 mb-3">Add a sponsor</h2>
          <SponsorForm sponsor={null} shows={allShows} images={images} action="/admin/sponsors" />
        </div>
      </div>,
      { title: 'Sponsors' },
    );
  },
);

function SponsorForm({
  sponsor,
  shows: allShows,
  images,
  action,
}: {
  sponsor: typeof sponsors.$inferSelect | null;
  shows: { id: string; title: string }[];
  images: ImageStore;
  action: string;
}) {
  const logo = images.deliveryUrl(sponsor?.logoImageId, IMAGE_VARIANT.Thumb);

  return (
    <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-5">
      <form method="post" action={action} enctype="multipart/form-data" class="space-y-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class={label} for={`name-${sponsor?.id ?? 'new'}`}>
              Name
            </label>
            <input
              type="text"
              id={`name-${sponsor?.id ?? 'new'}`}
              name="name"
              required
              maxlength={120}
              value={sponsor?.name ?? ''}
              class={input}
            />
          </div>

          <div>
            <label class={label} for={`website-${sponsor?.id ?? 'new'}`}>
              Website
            </label>
            <input
              type="url"
              id={`website-${sponsor?.id ?? 'new'}`}
              name="website"
              placeholder="https://example.com"
              value={sponsor?.website ?? ''}
              class={input}
            />
          </div>

          <div>
            <label class={label} for={`tier-${sponsor?.id ?? 'new'}`}>
              Tier
            </label>
            <select
              id={`tier-${sponsor?.id ?? 'new'}`}
              name="tier"
              class={`${input} bg-white`}
            >
              {Object.values(SPONSOR_TIER).map((t) => (
                <option value={t} selected={sponsor?.tier === t}>
                  {SPONSOR_TIER_LABELS[t]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label class={label} for={`show-${sponsor?.id ?? 'new'}`}>
              Sponsoring
            </label>
            <select
              id={`show-${sponsor?.id ?? 'new'}`}
              name="showId"
              class={`${input} bg-white`}
            >
              <option value="" selected={!sponsor?.showId}>
                The club generally
              </option>
              {allShows.map((s) => (
                <option value={s.id} selected={sponsor?.showId === s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </div>
        </div>

        <ImageField
          name="logo"
          url={logo}
          hint={
            sponsor
              ? 'Leave empty to keep the current logo.'
              : `Logo, up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB. Without one the name is shown as text.`
          }
        />

        <div class="flex flex-wrap items-center gap-4">
          <label class="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              name="isActive"
              value="1"
              checked={sponsor ? sponsor.isActive : true}
            />
            Show on the site
          </label>

          <button type="submit" class={primaryButton}>
            {sponsor ? 'Save' : 'Add sponsor'}
          </button>
        </div>
      </form>

      {sponsor && (
        <div class="mt-3 pt-3 border-t border-neutral-100 flex justify-end">
          <DeleteButton action={`/admin/sponsors/${sponsor.id}/delete`} name={sponsor.name} />
        </div>
      )}
    </div>
  );
}

/**
 * Shared parse for both the create and update sponsor routes.
 *
 * The return type is written out rather than inferred: inference widens both
 * branches to carry an optional `error`, which defeats `'error' in parsed`
 * narrowing at the call sites.
 */
type SponsorFormResult =
  | { error: string; values?: undefined }
  | { error?: undefined; values: Omit<SponsorInput, 'logoImageId'> & { logoImageId?: string } };

async function readSponsorForm(c: Context<AppEnv>): Promise<SponsorFormResult> {
  const form = await c.req.formData();
  const tier = String(form.get('tier') ?? '');
  const website = String(form.get('website') ?? '').trim();
  const showId = String(form.get('showId') ?? '').trim();

  const upload = await uploadImage(c.get('images'), form.get('logo'));
  if (upload && 'error' in upload) return { error: upload.error };

  return {
    values: {
      name: String(form.get('name') ?? '').trim(),
      website: website.length > 0 ? website : null,
      tier: isSponsorTier(tier) ? tier : SPONSOR_TIER.Bronze,
      showId: showId.length > 0 ? showId : null,
      isActive: Boolean(form.get('isActive')),
      logoImageId: upload?.imageId,
    },
  };
}

adminCatalogRoutes.post(
  '/admin/sponsors',
  requirePermission('sponsor', 'manage'),
  async (c) => {
    const parsed = await readSponsorForm(c);
    if (parsed.error !== undefined) {
      return c.redirect(`/admin/sponsors?error=${encodeURIComponent(parsed.error)}`, 302);
    }
    if (parsed.values.name.length === 0) {
      return c.redirect('/admin/sponsors?error=A%20sponsor%20needs%20a%20name.', 302);
    }

    await createSponsor(getDb(c.env.DB), c.get('actor'), {
      ...parsed.values,
      logoImageId: parsed.values.logoImageId ?? null,
    });
    return c.redirect('/admin/sponsors', 302);
  },
);

adminCatalogRoutes.post(
  '/admin/sponsors/:id',
  requirePermission('sponsor', 'manage'),
  async (c) => {
    const parsed = await readSponsorForm(c);
    if (parsed.error !== undefined) {
      return c.redirect(`/admin/sponsors?error=${encodeURIComponent(parsed.error)}`, 302);
    }

    await updateSponsor(getDb(c.env.DB), c.get('actor'), c.req.param('id'), parsed.values);
    return c.redirect('/admin/sponsors', 302);
  },
);

adminCatalogRoutes.post(
  '/admin/sponsors/:id/delete',
  requirePermission('sponsor', 'manage'),
  async (c) => {
    await deleteSponsor(getDb(c.env.DB), c.get('actor'), c.req.param('id'));
    return c.redirect('/admin/sponsors', 302);
  },
);

// ------------------------------------------------------------- spirit wear

adminCatalogRoutes.get(
  '/admin/spiritwear',
  requirePermission('spiritwear', 'manage'),
  async (c) => {
    const db = getDb(c.env.DB);
    const images = c.get('images');
    const all = await db.select().from(spiritWear).orderBy(asc(spiritWear.name));
    const error = c.req.query('error');

    return c.render(
      <div class="space-y-6 max-w-4xl">
        <h1 class="font-display text-2xl font-bold text-neutral-900">Spirit Wear</h1>

        {error && (
          <p class="rounded-lg bg-red-50 text-red-800 text-sm px-4 py-3 ring-1 ring-red-200">
            {error}
          </p>
        )}

        <p class="text-sm text-neutral-600">
          The site lists what is for sale; it does not take orders or payment. Unticking
          "Available" hides an item without deleting it.
        </p>

        {all.map((item) => (
          <SpiritWearForm item={item} images={images} action={`/admin/spiritwear/${item.id}`} />
        ))}

        <div>
          <h2 class="font-display font-semibold text-neutral-900 mb-3">Add an item</h2>
          <SpiritWearForm item={null} images={images} action="/admin/spiritwear" />
        </div>
      </div>,
      { title: 'Spirit Wear' },
    );
  },
);

function SpiritWearForm({
  item,
  images,
  action,
}: {
  item: typeof spiritWear.$inferSelect | null;
  images: ImageStore;
  action: string;
}) {
  const key = item?.id ?? 'new';
  const photo = images.deliveryUrl(item?.imageId, IMAGE_VARIANT.Gallery);

  return (
    <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-5">
      <form method="post" action={action} enctype="multipart/form-data" class="space-y-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class={label} for={`sw-name-${key}`}>
              Name
            </label>
            <input
              type="text"
              id={`sw-name-${key}`}
              name="name"
              required
              maxlength={120}
              value={item?.name ?? ''}
              class={input}
            />
          </div>

          <div>
            <label class={label} for={`sw-price-${key}`}>
              Price
            </label>
            <input
              type="text"
              id={`sw-price-${key}`}
              name="price"
              required
              inputmode="decimal"
              placeholder="25.00"
              value={item ? (item.priceCents / 100).toFixed(2) : ''}
              class={input}
            />
          </div>

          <div class="sm:col-span-2">
            <label class={label} for={`sw-desc-${key}`}>
              Description
            </label>
            <textarea
              id={`sw-desc-${key}`}
              name="description"
              required
              rows={2}
              maxlength={500}
              class={input}
            >
              {item?.description ?? ''}
            </textarea>
          </div>

          <div>
            <label class={label} for={`sw-cat-${key}`}>
              Category
            </label>
            <select id={`sw-cat-${key}`} name="category" class={`${input} bg-white`}>
              {Object.values(SPIRIT_WEAR_CATEGORY).map((cat) => (
                <option value={cat} selected={item?.category === cat}>
                  {SPIRIT_WEAR_CATEGORY_LABELS[cat]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label class={label} for={`sw-sizes-${key}`}>
              Sizes
            </label>
            <input
              type="text"
              id={`sw-sizes-${key}`}
              name="sizes"
              placeholder="S, M, L, XL"
              value={(item?.sizes ?? []).join(', ')}
              class={input}
            />
          </div>

          <div>
            <label class={label} for={`sw-colors-${key}`}>
              Colors
            </label>
            <input
              type="text"
              id={`sw-colors-${key}`}
              name="colors"
              placeholder="Navy, Grey"
              value={(item?.colors ?? []).join(', ')}
              class={input}
            />
          </div>

          <div class="sm:col-span-2">
            <ImageField
              name="image"
              url={photo}
              hint={
                item
                  ? 'Leave empty to keep the current photo.'
                  : `Product photo, up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`
              }
            />
          </div>
        </div>

        <p class="text-xs text-neutral-500">Separate sizes and colors with commas.</p>

        <div class="flex flex-wrap items-center gap-4">
          <label class="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              name="isAvailable"
              value="1"
              checked={item ? item.isAvailable : true}
            />
            Available
          </label>
          <label class="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              name="isFeatured"
              value="1"
              checked={item?.isFeatured ?? false}
            />
            Feature it
          </label>

          <button type="submit" class={primaryButton}>
            {item ? 'Save' : 'Add item'}
          </button>
        </div>
      </form>

      {item && (
        <div class="mt-3 pt-3 border-t border-neutral-100 flex justify-end">
          <DeleteButton action={`/admin/spiritwear/${item.id}/delete`} name={item.name} />
        </div>
      )}
    </div>
  );
}

type SpiritWearFormResult =
  | { error: string; values?: undefined }
  | { error?: undefined; values: Omit<SpiritWearInput, 'imageId'> & { imageId?: string } };

async function readSpiritWearForm(c: Context<AppEnv>): Promise<SpiritWearFormResult> {
  const form = await c.req.formData();
  const category = String(form.get('category') ?? '');

  // Rejected rather than coerced: a mistyped price silently stored as $0.00
  // would put the wrong number in front of the public.
  const priceCents = parsePriceCents(String(form.get('price') ?? ''));
  if (priceCents === null) {
    return { error: 'Enter a price as a number, for example 25.00.' };
  }

  const upload = await uploadImage(c.get('images'), form.get('image'));
  if (upload && 'error' in upload) return { error: upload.error };

  return {
    values: {
      name: String(form.get('name') ?? '').trim(),
      description: String(form.get('description') ?? '').trim(),
      priceCents,
      category: isSpiritWearCategory(category) ? category : SPIRIT_WEAR_CATEGORY.Apparel,
      sizes: parseList(String(form.get('sizes') ?? '')),
      colors: parseList(String(form.get('colors') ?? '')),
      isAvailable: Boolean(form.get('isAvailable')),
      isFeatured: Boolean(form.get('isFeatured')),
      imageId: upload?.imageId,
    },
  };
}

adminCatalogRoutes.post(
  '/admin/spiritwear',
  requirePermission('spiritwear', 'manage'),
  async (c) => {
    const parsed = await readSpiritWearForm(c);
    if (parsed.error !== undefined) {
      return c.redirect(`/admin/spiritwear?error=${encodeURIComponent(parsed.error)}`, 302);
    }
    if (parsed.values.name.length === 0) {
      return c.redirect('/admin/spiritwear?error=An%20item%20needs%20a%20name.', 302);
    }

    await createSpiritWear(getDb(c.env.DB), c.get('actor'), {
      ...parsed.values,
      imageId: parsed.values.imageId ?? null,
    });
    return c.redirect('/admin/spiritwear', 302);
  },
);

adminCatalogRoutes.post(
  '/admin/spiritwear/:id',
  requirePermission('spiritwear', 'manage'),
  async (c) => {
    const parsed = await readSpiritWearForm(c);
    if (parsed.error !== undefined) {
      return c.redirect(`/admin/spiritwear?error=${encodeURIComponent(parsed.error)}`, 302);
    }

    await updateSpiritWear(getDb(c.env.DB), c.get('actor'), c.req.param('id'), parsed.values);
    return c.redirect('/admin/spiritwear', 302);
  },
);

adminCatalogRoutes.post(
  '/admin/spiritwear/:id/delete',
  requirePermission('spiritwear', 'manage'),
  async (c) => {
    await deleteSpiritWear(getDb(c.env.DB), c.get('actor'), c.req.param('id'));
    return c.redirect('/admin/spiritwear', 302);
  },
);
