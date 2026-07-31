import type { Bindings } from '~/env';
import { CloudflareImageStore } from './cloudflare';
import { LocalImageStore } from './local';
import type { ImageStore } from './types';

export * from './types';
export { CloudflareImageStore } from './cloudflare';
export { LocalImageStore, LOCAL_IMAGE_PREFIX } from './local';

/**
 * Chooses an image store from configuration rather than from an explicit
 * environment flag.
 *
 * The account hash is the thing Cloudflare Images cannot work without, so its
 * presence is the honest signal. This also means the project works today,
 * before an Images plan exists, and switches over the moment the credentials
 * are added - with no flag to remember to flip and no chance of the flag
 * disagreeing with reality.
 */
export function getImageStore(env: Bindings, requestUrl: string): ImageStore {
  const hash = env.CF_IMAGES_ACCOUNT_HASH;

  if (hash && hash.length > 0 && !hash.startsWith('PLACEHOLDER')) {
    return new CloudflareImageStore({
      accountHash: hash,
      accountId: env.CF_IMAGES_ACCOUNT_ID,
      apiToken: env.CF_IMAGES_API_TOKEN,
    });
  }

  return new LocalImageStore({ kv: env.KV, baseUrl: new URL(requestUrl).origin });
}
