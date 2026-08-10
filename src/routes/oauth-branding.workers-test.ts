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

  it('explains what the site is, above everything but the hero', async () => {
    const body = await home();

    // Verification was refused twice for a home page that "does not explain
    // the purpose of your app" - first with the explanation at the bottom of
    // the page, then with it as a one-line band. Position and substance are
    // both the fix, so both are asserted.
    const about = body.indexOf('About This Website');
    expect(about).toBeGreaterThan(-1);

    for (const later of ['Latest News', 'Never Miss a Show']) {
      const at = body.indexOf(later);
      if (at > -1) expect(about, `${later} should come after`).toBeLessThan(at);
    }
  });

  it('names the site and who publishes it', async () => {
    const body = await home();

    expect(body).toContain('official website of the Fairport High School');
    expect(body).toContain('Drama Club Boosters');
    expect(body).toContain('volunteer parent organization');
  });

  it('leads with the name registered on the OAuth consent screen', async () => {
    const body = await home();

    // The reviewer compares the consent screen's app name against the home
    // page. "Fairport Drama" is what is registered, so the page says it in the
    // header and again as the subject of the opening sentence.
    expect(body).toContain('Fairport Drama is the official website');
  });

  it('says what the members area does, which is what the OAuth client is for', async () => {
    const body = await home();

    expect(body).toContain('Run by the club itself');
    expect(body).toContain('Google account');
    expect(body).toContain('invitation only');
    expect(body).toContain('does not create an account');
  });

  it('says student profiles start private', async () => {
    expect(await home()).toContain('starts private');
  });

  it('says what Google data is requested and why', async () => {
    const body = await home();

    // Google's App Homepage requirements are three clauses. This is the third
    // - "explain with transparency the purpose for which your app requests
    // user data" - and it was the one the page never answered, while four
    // rewrites addressed the first two. The check is against the registered
    // home page and does not follow links, so it has to be said here.
    expect(body).toContain('requests only their');
    expect(body).toContain('email address and basic profile');
    expect(body).toContain('to match the person signing in to the invitation');
  });

  it('says what is not done with that data', async () => {
    const body = await home();

    expect(body).toContain('Nothing else is read from a Google account');
    expect(body).toContain('advertising');
    expect(body).toContain('sold or shared');
  });

  it('links the privacy policy from the paragraph about data', async () => {
    const body = await home();
    const notice = body.indexOf('Signing in with Google');
    expect(notice).toBeGreaterThan(-1);

    // The same requirements ask the home page to carry a privacy policy link
    // matching the consent screen. The footer link satisfies the letter of it;
    // one beside the sentence about what is collected is the point of it.
    expect(body.slice(notice, notice + 1600)).toContain('href="/privacy"');
  });

  it('keeps the data notice on the page, below the club content', async () => {
    const body = await home();

    // Moved out of the opening section deliberately: it was several hundred
    // words of compliance copy at the top of the funnel, and the check failed
    // with it there anyway, so position was never what was being measured.
    const about = body.indexOf('About This Website');
    const notice = body.indexOf('Signing in with Google');
    expect(notice).toBeGreaterThan(about);
  });

  it('describes it once, not in two competing places', async () => {
    const body = await home();

    // There used to be a band under the hero and a fuller section near the
    // bottom saying the same thing differently.
    expect((body.match(/About This Website/g) ?? []).length).toBe(1);
    expect(body).not.toContain('For Club Members');
  });

  it('links to the fuller page, to sign-in, and to the policies', async () => {
    const body = await home();

    // From the footer and the nav rather than from the About section, which
    // is prose now. What matters for the review is that the home page reaches
    // them, not which block they sit in.
    expect(body).toContain('href="/about/website"');
    expect(body).toContain('href="/admin/sign-in"');
    expect(body).toContain('href="/about/boosters"');
    expect(body).toContain('href="/privacy"');
    expect(body).toContain('href="/terms"');
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
