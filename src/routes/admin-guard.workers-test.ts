import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '~/index';

/**
 * Route-level guards.
 *
 * These exercise the real app, so they cover the middleware ordering as well
 * as the guards themselves - an admin route accidentally mounted after the
 * public layout, or before the actor middleware, would show up here.
 */

const get = (path: string) =>
  app.fetch(new Request(`https://fairportdrama.com${path}`, { redirect: 'manual' }), env);

const post = (path: string) =>
  app.fetch(
    new Request(`https://fairportdrama.com${path}`, {
      method: 'POST',
      redirect: 'manual',
      body: new FormData(),
    }),
    env,
  );

const PROTECTED = [
  '/admin',
  '/admin/profile',
  '/admin/approvals',
  '/admin/members',
  '/admin/audit',
];

describe('unauthenticated access', () => {
  it('redirects every protected page to sign-in', async () => {
    for (const path of PROTECTED) {
      const response = await get(path);
      expect(response.status, path).toBe(302);
      expect(response.headers.get('location'), path).toContain('/admin/sign-in');
    }
  });

  it('preserves the intended destination so sign-in returns there', async () => {
    const response = await get('/admin/approvals');
    expect(response.headers.get('location')).toContain(
      `next=${encodeURIComponent('/admin/approvals')}`,
    );
  });

  it('does not apply a mutation posted without a session', async () => {
    const response = await post('/admin/profile');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/sign-in');
  });

  it('leaves the sign-in page itself reachable', async () => {
    const response = await get('/admin/sign-in');
    expect(response.status).toBe(200);
  });
});

describe('admin responses are never cached or indexed', () => {
  // Admin pages render student data and audit history per user. Edge caching
  // one would serve it to the next visitor.
  it('sets no-store and noindex on the sign-in page', async () => {
    const response = await get('/admin/sign-in');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('sets them on redirects away from protected pages too', async () => {
    const response = await get('/admin/approvals');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});

describe('admin is excluded from discovery', () => {
  it('robots.txt disallows /admin', async () => {
    const response = await get('/robots.txt');
    expect(await response.text()).toContain('Disallow: /admin');
  });

  it('the sitemap contains no admin URLs', async () => {
    const response = await get('/sitemap.xml');
    expect(await response.text()).not.toContain('/admin');
  });
});

describe('public routes remain unaffected by the admin mount', () => {
  it('still serves the homepage', async () => {
    expect((await get('/')).status).toBe(200);
  });

  it('still 404s unknown paths rather than redirecting to sign-in', async () => {
    expect((await get('/definitely-not-a-page')).status).toBe(404);
  });
});
