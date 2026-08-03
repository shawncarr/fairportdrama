import type { ImageStore, ImageVariant, StoredImage } from './types';

export interface CloudflareImageStoreInput {
  /** Appears in every public delivery URL, so not a secret. */
  accountHash: string;
  /** The Workers Images binding. Hosted-image operations go through this. */
  images: ImagesBinding;
  deliveryBaseUrl?: string;
}

const DEFAULT_DELIVERY_BASE = 'https://imagedelivery.net';

/**
 * Cloudflare Images.
 *
 * Writes go through the Workers Images binding (`env.IMAGES.hosted`) rather
 * than the REST API. The binding needs no API token and no account id, which
 * removes the only secret from a path students upload through - the account
 * hash below is public and appears in every delivery URL.
 *
 * Reads still come from imagedelivery.net directly, so the local KV shim
 * exists for development, where there is no Images account to talk to.
 */
export class CloudflareImageStore implements ImageStore {
  readonly name = 'CloudflareImages';

  readonly #accountHash: string;
  readonly #images: ImagesBinding;
  readonly #deliveryBase: string;

  constructor(input: CloudflareImageStoreInput) {
    this.#accountHash = input.accountHash;
    this.#images = input.images;
    this.#deliveryBase = input.deliveryBaseUrl ?? DEFAULT_DELIVERY_BASE;
  }

  deliveryUrl(imageId: string | null | undefined, variant: ImageVariant): string | null {
    if (!imageId) return null;
    return `${this.#deliveryBase}/${this.#accountHash}/${imageId}/${variant}`;
  }

  async put(bytes: ArrayBuffer, _contentType: string, imageId?: string): Promise<string> {
    // Content type is not passed: Cloudflare sniffs the format itself, and the
    // caller has already verified the bytes really are an image.
    const result = await this.#images.hosted.upload(bytes, {
      ...(imageId ? { id: imageId } : {}),
      // These are public site images, not signed assets.
      requireSignedURLs: false,
    });
    return result.id;
  }

  /**
   * Not implemented: Cloudflare serves its own bytes from the delivery URL, so
   * nothing in this app reads them back through the Worker. The local shim
   * does, which is why the method exists on the interface at all.
   */
  async get(): Promise<StoredImage | null> {
    return null;
  }

  async delete(imageId: string): Promise<void> {
    await this.#images.hosted.image(imageId).delete();
  }
}
