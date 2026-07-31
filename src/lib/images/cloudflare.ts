import type { ImageStore, ImageVariant, StoredImage } from './types';

export interface CloudflareImageStoreInput {
  /** Appears in every public delivery URL, so not a secret. */
  accountHash: string;
  accountId: string;
  /** Images:Edit scope. A secret. */
  apiToken: string;
  deliveryBaseUrl?: string;
  apiBaseUrl?: string;
}

const DEFAULT_DELIVERY_BASE = 'https://imagedelivery.net';
const DEFAULT_API_BASE = 'https://api.cloudflare.com';

/**
 * Cloudflare Images.
 *
 * There is no Workers binding for Images - every write is an HTTPS call to
 * api.cloudflare.com - which is exactly why the local shim exists alongside
 * this.
 */
export class CloudflareImageStore implements ImageStore {
  readonly name = 'CloudflareImages';

  readonly #accountHash: string;
  readonly #accountId: string;
  readonly #apiToken: string;
  readonly #deliveryBase: string;
  readonly #apiBase: string;

  constructor(input: CloudflareImageStoreInput) {
    this.#accountHash = input.accountHash;
    this.#accountId = input.accountId;
    this.#apiToken = input.apiToken;
    this.#deliveryBase = input.deliveryBaseUrl ?? DEFAULT_DELIVERY_BASE;
    this.#apiBase = input.apiBaseUrl ?? DEFAULT_API_BASE;
  }

  deliveryUrl(imageId: string | null | undefined, variant: ImageVariant): string | null {
    if (!imageId) return null;
    return `${this.#deliveryBase}/${this.#accountHash}/${imageId}/${variant}`;
  }

  async put(bytes: ArrayBuffer, contentType: string): Promise<string> {
    const body = new FormData();
    body.append('file', new Blob([bytes], { type: contentType }));
    // These are public site images, not signed assets.
    body.append('requireSignedURLs', 'false');

    const response = await fetch(
      `${this.#apiBase}/client/v4/accounts/${this.#accountId}/images/v1`,
      { method: 'POST', headers: { Authorization: `Bearer ${this.#apiToken}` }, body },
    );

    const json = (await response.json()) as {
      success: boolean;
      result?: { id: string };
      errors?: unknown;
    };
    if (!response.ok || !json.success || !json.result) {
      throw new Error(`Cloudflare Images upload failed: ${JSON.stringify(json.errors)}`);
    }
    return json.result.id;
  }

  /**
   * Not implemented: Cloudflare serves its own bytes from the delivery URL, so
   * nothing in this app ever reads them back through the Worker. The local
   * shim does, which is why the method exists on the interface at all.
   */
  async get(): Promise<StoredImage | null> {
    return null;
  }

  async delete(imageId: string): Promise<void> {
    await fetch(
      `${this.#apiBase}/client/v4/accounts/${this.#accountId}/images/v1/${imageId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${this.#apiToken}` } },
    );
  }
}
