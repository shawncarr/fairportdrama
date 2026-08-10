import { beforeEach, describe, expect, it } from 'vitest';
import { get, resetTables } from '~/test/session';

/**
 * The page registered with Google as the application's home page.
 *
 * Google refused verification twice - "your home page is behind a login page"
 * and "your home page does not explain the purpose of your app" - and both are
 * properties of a page rather than of the OAuth configuration. Asserting them
 * here means a later redesign fails locally, rather than in an email weeks
 * after somebody resubmits.
 */

beforeEach(async () => {
  await resetTables(['member_offices', 'member_roles', 'members']);
});

const page = async (path = '/about/website') => {
  const res = await get(path);
  expect(res.status).toBe(200);
  return res.text();
};

describe('reachability', () => {
  it('serves without a session and without redirecting', async () => {
    const res = await get('/about/website');

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('is not itself a sign-in page', async () => {
    const body = await page();

    // The complaint was that the registered page was a login screen. This one
    // links to sign-in; it does not ask for credentials. (The footer carries a
    // newsletter signup, so an email field alone proves nothing - what matters
    // is that nothing here posts to the auth routes.)
    expect(body).not.toContain('type="password"');
    expect(body).not.toContain('action="/admin/sign-in"');
    expect(body).toContain('href="/admin/sign-in"');
  });
});

describe('what it has to say about the application', () => {
  it('describes what the software does, not only what the club is', async () => {
    const body = await page();

    expect(body).toContain('What this application does');
    for (const capability of ['cast and crew', 'news', 'photograph', 'roster', 'profile']) {
      expect(body.toLowerCase()).toContain(capability.toLowerCase());
    }
  });

  it('explains how signing in works and what is asked of Google', async () => {
    const body = await page();

    expect(body).toContain('How signing in works');
    expect(body).toContain('Google account');
    expect(body).toContain('does not create an account');
    expect(body).toContain('invitation only');
  });

  it('states that student profiles start private', async () => {
    // The reviewer is looking at a site about minors; saying so is honest and
    // it is also what the code does.
    expect(await page()).toContain('starts private');
  });

  it('links to the privacy policy, the terms, and a way in', async () => {
    const body = await page();

    expect(body).toContain('href="/privacy"');
    expect(body).toContain('href="/terms"');
    expect(body).toContain('href="/admin/sign-in"');
    expect(body).toContain('href="/about/contact"');
  });
});

describe('it is not an orphan', () => {
  it('is linked from the site root', async () => {
    expect(await page('/')).toContain('href="/about/website"');
  });

  it('is linked from the footer on every page', async () => {
    for (const path of ['/', '/members', '/news']) {
      expect(await page(path), path).toContain('href="/about/website"');
    }
  });

  it('is in the sitemap', async () => {
    const res = await get('/sitemap.xml');
    expect(await res.text()).toContain('/about/website');
  });

  it('is not blocked by robots.txt', async () => {
    const robots = await (await get('/robots.txt')).text();

    // Only /admin and /api are disallowed; a blocked page cannot be reviewed.
    expect(robots).toContain('Disallow: /admin');
    expect(robots).not.toContain('Disallow: /about');
  });
});

describe('the site root, which is the other candidate', () => {
  it('is also public and also explains the members area', async () => {
    const body = await page('/');

    expect(body).toContain('For Club Members');
    expect(body).toContain('invitation only');
  });
});
