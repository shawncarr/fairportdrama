/**
 * Cloudflare Images delivery URLs.
 *
 * Ids are opaque, so nothing about the subject is inferable from the URL. That
 * is deliberate: a member set to `limited` visibility must not be identifiable
 * from the address of their own photo, which is exactly what colocated
 * filenames like `daniel-doser-charlottes-web-2025.jpg` gave away.
 */

export const IMAGE_VARIANT = {
  /** Member cards and profiles, 400x400. */
  Thumb: 'thumb',
  /** Show posters, 600x900 portrait. */
  Poster: 'poster',
  /** Hero banners, 1920x1080. */
  Hero: 'hero',
  /** Social sharing, 1200x630. */
  Og: 'og',
  /** Gallery thumbnails, 800x800. */
  Gallery: 'gallery',
} as const;

export type ImageVariant = (typeof IMAGE_VARIANT)[keyof typeof IMAGE_VARIANT];

/**
 * Account hash for imagedelivery.net. Not a secret - it appears in every
 * public image URL - so it lives in config rather than in secrets.
 */
const ACCOUNT_HASH = 'PLACEHOLDER_IMAGES_ACCOUNT_HASH';

export function imageUrl(
  imageId: string | null | undefined,
  variant: ImageVariant,
): string | null {
  if (!imageId) return null;
  return `https://imagedelivery.net/${ACCOUNT_HASH}/${imageId}/${variant}`;
}

/**
 * Resolves an image with a documented fallback chain.
 *
 * Open Graph images fall back to the hero (closer aspect ratio) and then the
 * poster, matching the behaviour the Astro site documented.
 */
export function ogImageUrl(
  ids: { og?: string | null; hero?: string | null; poster?: string | null },
): string | null {
  return (
    imageUrl(ids.og, IMAGE_VARIANT.Og) ??
    imageUrl(ids.hero, IMAGE_VARIANT.Og) ??
    imageUrl(ids.poster, IMAGE_VARIANT.Og)
  );
}
