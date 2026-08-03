import type { Bindings } from '~/env';
import { CloudflareImageStore } from './cloudflare';
import { LocalImageStore } from './local';
import type { ImageStore } from './types';

export * from './types';
export { CloudflareImageStore } from './cloudflare';
export { LocalImageStore, LOCAL_IMAGE_PREFIX } from './local';
export { MAX_IMAGE_BYTES, readImageUpload, sniffImageType, uploadImage } from './upload';

/**
 * Chooses an image store from configuration rather than from an explicit
 * environment flag.
 *
 * The account hash is the thing Cloudflare Images cannot work without - it is
 * in every delivery URL - so its presence is the honest signal. This also
 * means the project works today, before an Images plan exists, and switches
 * over the moment the hash is set, with no flag to remember to flip and no
 * chance of the flag disagreeing with reality.
 *
 * The hash is now the only configuration needed. Uploads go through the
 * Images binding, so there is no API token or account id to set.
 */
export function getImageStore(env: Bindings, requestUrl: string): ImageStore {
  const hash = env.CF_IMAGES_ACCOUNT_HASH;

  if (hash && hash.length > 0 && !hash.startsWith('PLACEHOLDER')) {
    return new CloudflareImageStore({ accountHash: hash, images: env.IMAGES });
  }

  return new LocalImageStore({ kv: env.KV, baseUrl: new URL(requestUrl).origin });
}
