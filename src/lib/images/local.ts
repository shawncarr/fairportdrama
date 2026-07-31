import { generateId } from '~/lib/id';
import type { ImageStore, ImageVariant, StoredImage } from './types';

export const LOCAL_IMAGE_PREFIX = 'local-image:';

const sourceKey = (imageId: string) => `${LOCAL_IMAGE_PREFIX}${imageId}`;
const metaKey = (imageId: string) => `${LOCAL_IMAGE_PREFIX}${imageId}:meta`;

/**
 * KV-backed stand-in for Cloudflare Images, for local development.
 *
 * Cloudflare Images is a REST SaaS with no Workers binding, so miniflare cannot
 * emulate it. Without this, `wrangler dev` renders a site with no images at
 * all - which hides layout problems until deploy and makes the admin
 * impossible to exercise.
 *
 * KV is used rather than R2 because the KV binding already exists; adding an
 * R2 bucket would mean provisioning a real one for production, where it would
 * then go unused because the real store handles everything.
 *
 * Variants are pass-throughs: the shim serves the original bytes whatever
 * variant is requested. It does not resize. Callers still pass a variant so
 * the URL shape matches production exactly.
 */
export class LocalImageStore implements ImageStore {
  readonly name = 'LocalImages';

  readonly #kv: KVNamespace;
  readonly #baseUrl: string;

  constructor(input: { kv: KVNamespace; baseUrl: string }) {
    this.#kv = input.kv;
    this.#baseUrl = input.baseUrl.replace(/\/$/, '');
  }

  deliveryUrl(imageId: string | null | undefined, variant: ImageVariant): string | null {
    if (!imageId) return null;
    return `${this.#baseUrl}/dev/images/${imageId}/${variant}`;
  }

  async put(bytes: ArrayBuffer, contentType: string, imageId?: string): Promise<string> {
    const id = imageId ?? generateId();
    await this.#kv.put(sourceKey(id), bytes);
    await this.#kv.put(metaKey(id), JSON.stringify({ contentType }));
    return id;
  }

  async get(imageId: string): Promise<StoredImage | null> {
    const body = await this.#kv.get(sourceKey(imageId), 'arrayBuffer');
    if (!body) return null;

    const meta = await this.#kv.get(metaKey(imageId), 'json');
    const contentType =
      meta && typeof meta === 'object' && 'contentType' in meta
        ? String((meta as { contentType: unknown }).contentType)
        : 'application/octet-stream';

    return { body, contentType };
  }

  async delete(imageId: string): Promise<void> {
    await Promise.all([
      this.#kv.delete(sourceKey(imageId)),
      this.#kv.delete(metaKey(imageId)),
    ]);
  }
}
