import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { CloudflareImageStore } from './cloudflare';
import { LocalImageStore } from './local';
import { getImageStore } from './index';
import { IMAGE_VARIANT, ogImageUrl } from './types';

const local = () =>
  new LocalImageStore({ kv: env.KV, baseUrl: 'https://dev.example.com' });

const cloudflare = () =>
  new CloudflareImageStore({
    accountHash: 'HASH123',
    accountId: 'acct',
    apiToken: 'token',
  });

describe('delivery URLs', () => {
  it('local points at the worker dev route', () => {
    expect(local().deliveryUrl('img1', IMAGE_VARIANT.Thumb)).toBe(
      'https://dev.example.com/dev/images/img1/thumb',
    );
  });

  it('cloudflare points at imagedelivery', () => {
    expect(cloudflare().deliveryUrl('img1', IMAGE_VARIANT.Poster)).toBe(
      'https://imagedelivery.net/HASH123/img1/poster',
    );
  });

  // Both stores must agree here, because the templates only ever see the
  // result and cannot tell which store produced it.
  it('both return null for a missing image id', () => {
    for (const store of [local(), cloudflare()]) {
      expect(store.deliveryUrl(null, IMAGE_VARIANT.Thumb)).toBeNull();
      expect(store.deliveryUrl(undefined, IMAGE_VARIANT.Thumb)).toBeNull();
      expect(store.deliveryUrl('', IMAGE_VARIANT.Thumb)).toBeNull();
    }
  });

  it('both carry the variant, so the URL shape matches in either environment', () => {
    for (const store of [local(), cloudflare()]) {
      expect(store.deliveryUrl('x', IMAGE_VARIANT.Og)).toContain('/og');
    }
  });
});

describe('ogImageUrl fallback chain', () => {
  it('prefers the dedicated og image', () => {
    expect(ogImageUrl(local(), { og: 'a', hero: 'b', poster: 'c' })).toContain('/a/');
  });

  it('falls back to hero, then poster', () => {
    expect(ogImageUrl(local(), { og: null, hero: 'b', poster: 'c' })).toContain('/b/');
    expect(ogImageUrl(local(), { og: null, hero: null, poster: 'c' })).toContain('/c/');
  });

  it('returns null when a show has no images at all', () => {
    expect(ogImageUrl(local(), {})).toBeNull();
  });
});

describe('local store round-trips bytes', () => {
  beforeEach(async () => {
    await env.KV.delete('local-image:round-trip');
    await env.KV.delete('local-image:round-trip:meta');
  });

  it('stores and returns the same bytes with its content type', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const id = await local().put(bytes, 'image/png', 'round-trip');
    expect(id).toBe('round-trip');

    const stored = await local().get('round-trip');
    expect(stored?.contentType).toBe('image/png');
    expect(new Uint8Array(stored!.body)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('returns null for an unknown image rather than throwing', async () => {
    expect(await local().get('not-a-real-image')).toBeNull();
  });

  it('deletes both the bytes and the metadata', async () => {
    await local().put(new Uint8Array([9]).buffer, 'image/png', 'round-trip');
    await local().delete('round-trip');
    expect(await local().get('round-trip')).toBeNull();
    expect(await env.KV.get('local-image:round-trip:meta')).toBeNull();
  });
});

describe('store selection', () => {
  // Only the fields getImageStore reads; `env` itself is not spreadable.
  const base = (hash: string) =>
    ({
      KV: env.KV,
      CF_IMAGES_ACCOUNT_HASH: hash,
      CF_IMAGES_ACCOUNT_ID: 'acct',
      CF_IMAGES_API_TOKEN: 'token',
    }) as never;

  it('uses the local shim when no account hash is configured', () => {
    const store = getImageStore(base(''), 'https://localhost:8787/');
    expect(store.name).toBe('LocalImages');
  });

  // The placeholder is what ships in wrangler.jsonc before an Images plan
  // exists, so it must not be mistaken for real configuration.
  it('treats the placeholder hash as unconfigured', () => {
    const store = getImageStore(
      base('PLACEHOLDER_IMAGES_ACCOUNT_HASH'),
      'https://localhost:8787/',
    );
    expect(store.name).toBe('LocalImages');
  });

  it('switches to Cloudflare as soon as a real hash is present', () => {
    const store = getImageStore(base('realhash'), 'https://fairportdrama.com/');
    expect(store.name).toBe('CloudflareImages');
  });

  it('derives the local base URL from the request, so ports do not need configuring', () => {
    const store = getImageStore(base(''), 'http://127.0.0.1:8899/some/page');
    expect(store.deliveryUrl('x', IMAGE_VARIANT.Thumb)).toBe(
      'http://127.0.0.1:8899/dev/images/x/thumb',
    );
  });
});
