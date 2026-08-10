import { beforeEach, describe, expect, it } from 'vitest';
import { get, resetTables } from '~/test/session';

/**
 * What Google's OAuth review checks on the home page.
 *
 * The verification was refused twice: "your home page is behind a login page"
 * and "your home page does not explain the purpose of your app". Both are
 * properties of a page rather than of the OAuth config, so they are asserted
 * here - a later redesign that dropped the section would fail the review again,
 * and the only signal would be an email weeks later.
 */

beforeEach(async () => {
  await resetTables(['member_offices', 'member_roles', 'members']);
});

const home = async () => {
  const res = await get('/');
  expect(res.status).toBe(200);
  return res.text();
};

describe('the registered home page', () => {
  it('is served without signing in', async () => {
    const res = await get('/');

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('explains what the application is for, not only what the club is', async () => {
    const body = await home();

    expect(body).toContain('For Club Members');
    expect(body).toMatch(/sign in/i);
    expect(body).toContain('invitation only');
  });

  it('says what the site is above the news, not only at the bottom', async () => {
    const body = await home();

    // Verification was refused for a home page that "does not explain the
    // purpose of your app" while the fuller section was already live - it sat
    // below the news, past shows and sponsors. Position is the fix.
    const statement = body.indexOf('The official website of the Fairport High School');
    expect(statement).toBeGreaterThan(-1);

    const fullSection = body.indexOf('For Club Members');
    expect(statement).toBeLessThan(fullSection);
  });

  it('names who publishes it, and links to them', async () => {
    const body = await home();

    expect(body).toContain('Drama Club Boosters');
    expect(body).toContain('volunteer parent organization');
    expect(body).toContain('href="/about/boosters"');
  });

  it('links to the page that describes the application in full', async () => {
    expect(await home()).toContain('href="/about/website"');
  });

  it('says how people sign in, which is what the OAuth client is used for', async () => {
    expect(await home()).toMatch(/Google account/);
  });

  it('links to the privacy policy and terms from the home page', async () => {
    const body = await home();

    expect(body).toContain('href="/privacy"');
    expect(body).toContain('href="/terms"');
  });

  it('offers a way in, and a way to ask for access', async () => {
    const body = await home();

    expect(body).toContain('href="/admin/sign-in"');
    expect(body).toContain('href="/about/contact"');
  });
});

describe('the pages it links to', () => {
  it('serves the privacy policy and terms publicly', async () => {
    for (const path of ['/privacy', '/terms']) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
    }
  });

  it('serves the sign-in page itself without a session', async () => {
    // Reachable, but it is not what gets registered as the home page: a login
    // screen is the thing Google objected to.
    expect((await get('/admin/sign-in')).status).toBe(200);
  });
});
