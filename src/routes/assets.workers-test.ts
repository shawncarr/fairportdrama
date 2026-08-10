import { describe, expect, it } from 'vitest';
import { get } from '~/test/session';

/**
 * That the layouts actually link the favicon.
 *
 * Whether the file exists is checked in lib/assets.test.ts: Cloudflare serves
 * the assets directory ahead of the Worker, so a request for it never reaches
 * anything this harness can drive. What is checkable here is the other half -
 * that both layouts still point at the name that is shipped.
 */

describe('the favicon link', () => {
  it('is on the public pages', async () => {
    for (const path of ['/', '/members', '/news']) {
      const body = await (await get(path)).text();
      expect(body, path).toContain('href="/favicon.svg"');
    }
  });

  it('is on the admin sign-in page, which uses the other layout', async () => {
    const body = await (await get('/admin/sign-in')).text();
    expect(body).toContain('href="/favicon.svg"');
  });
});
