import type { Bindings } from '~/env';
import { CloudflareImageStore } from './cloudflare';
import { LocalImageStore } from './local';
import type { ImageStore } from './types';

export * from './types';
export { CloudflareImageStore } from './cloudflare';
export { LocalImageStore, LOCAL_IMAGE_PREFIX } from './local';
export { MAX_IMAGE_BYTES, readImageUpload, sniffImageType, uploadImage } from './upload';

/** The one value of APP_ENV that means "this is the deployed site". */
export const PRODUCTION = 'production';

/**
 * Chooses an image store.
 *
 * Selection is driven by APP_ENV, not by whether the account hash happens to
 * be set. The hash lives in wrangler.jsonc and is therefore present during
 * local development too, so keying on it sent `wrangler dev` at the real
 * Images account - which meant a photo uploaded while testing the member form
 * landed in production storage.
 *
 * APP_ENV is a secret, so it is absent under `wrangler dev` unless .dev.vars
 * sets it, and development gets the local shim by default rather than by
 * remembering to opt out.
 *
 * The hash is still required, because every delivery URL contains it. Without
 * one there is nothing to build a URL from, so the shim is used even in
 * production: images will be missing, but the site still serves - a better
 * failure than throwing on every request.
 */
export function getImageStore(env: Bindings, requestUrl: string): ImageStore {
  const hash = env.CF_IMAGES_ACCOUNT_HASH;
  const configured = Boolean(hash) && hash.length > 0 && !hash.startsWith('PLACEHOLDER');

  if (env.APP_ENV === PRODUCTION && configured) {
    return new CloudflareImageStore({ accountHash: hash, images: env.IMAGES });
  }

  return new LocalImageStore({ kv: env.KV, baseUrl: new URL(requestUrl).origin });
}
