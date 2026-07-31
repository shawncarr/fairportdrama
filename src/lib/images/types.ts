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

export interface StoredImage {
  body: ArrayBuffer;
  contentType: string;
}

/**
 * Image storage, in the two forms this project needs.
 *
 * Cloudflare Images has no Workers binding - it is a REST API - so miniflare
 * cannot emulate it. Without a second implementation, local development shows
 * no images at all, which makes the site hard to work on and hides layout
 * problems until deploy.
 *
 * Both implementations satisfy this interface, so callers never branch on
 * environment. The only thing that differs is which one gets constructed.
 */
export interface ImageStore {
  readonly name: string;

  /** Pure URL construction. No network. */
  deliveryUrl(imageId: string | null | undefined, variant: ImageVariant): string | null;

  /** Stores bytes and returns the image id. */
  put(bytes: ArrayBuffer, contentType: string, imageId?: string): Promise<string>;

  /** Reads stored bytes. Only the local store serves its own bytes. */
  get(imageId: string): Promise<StoredImage | null>;

  delete(imageId: string): Promise<void>;
}

/**
 * Open Graph images fall back to the hero image (closer aspect ratio) and then
 * the poster, matching the behaviour documented on the Astro site.
 */
export function ogImageUrl(
  store: ImageStore,
  ids: { og?: string | null; hero?: string | null; poster?: string | null },
): string | null {
  return (
    store.deliveryUrl(ids.og, IMAGE_VARIANT.Og) ??
    store.deliveryUrl(ids.hero, IMAGE_VARIANT.Og) ??
    store.deliveryUrl(ids.poster, IMAGE_VARIANT.Og)
  );
}
