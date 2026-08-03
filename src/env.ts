import type { Actor } from '~/lib/audit/actor';
import type { AppRole } from '~/db/schema/governance';
import type { ImageStore } from '~/lib/images';

export interface Bindings {
  DB: D1Database;
  KV: KVNamespace;
  IMAGES: ImagesBinding;
  EMAIL: SendEmail;

  SITE_URL: string;

  CONTACT_EMAIL: string;
  TURNSTILE_SECRET_KEY: string;
  /** Public widget key. Not a secret - it is rendered into the page. */
  PUBLIC_TURNSTILE_SITE_KEY: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /**
   * Appears in every public delivery URL, so a var rather than a secret, and
   * the only Images configuration the Worker needs - uploads go through the
   * IMAGES binding, which requires no token.
   */
  CF_IMAGES_ACCOUNT_HASH: string;
}

export interface Variables {
  /**
   * Resolved once per request in middleware and never reconstructed at call
   * sites. Defaults to the system actor so an unenriched boundary attributes
   * to `system` rather than to a null user.
   */
  actor: Actor;
  /** Null for anonymous requests and for accounts with no role granted. */
  role: AppRole | null;
  /** Null for board members and volunteers, who hold no public profile. */
  memberId: string | null;
  /** Cloudflare Images when configured, otherwise the local KV shim. */
  images: ImageStore;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
