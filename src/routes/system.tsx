import { Hono } from 'hono';
import type { AppEnv } from '~/env';
import { describeError } from '~/lib/errors';
import { findByToken } from '~/services/newsletter';
import { getDb, getIndexableMemberIds, getPastShows, getPublishedNews, getCurrentShow } from '~/db/queries';

export const systemRoutes = new Hono<AppEnv>();

/**
 * Sitemap.
 *
 * Replaces @astrojs/sitemap. Member URLs come from getIndexableMemberIds,
 * which excludes anyone set to `limited` - listing those slugs would publish
 * the full names the visibility setting exists to withhold, even though the
 * pages themselves 404.
 */
systemRoutes.get('/sitemap.xml', async (c) => {
  const db = getDb(c.env.DB);
  const base = c.env.SITE_URL.replace(/\/$/, '');

  const [pastShows, currentShow, memberIds, news] = await Promise.all([
    getPastShows(db),
    getCurrentShow(db),
    getIndexableMemberIds(db),
    getPublishedNews(db),
  ]);

  const staticPaths = [
    '/',
    '/shows/past',
    '/members',
    '/members/alumni',
    '/news',
    '/spiritwear',
    '/about/boosters',
    '/about/sponsors',
    '/about/contact',
    '/about/website',
    '/disclaimer',
    '/privacy',
    '/terms',
  ];

  const urls = [
    ...staticPaths,
    ...(currentShow ? [`/shows/${currentShow.id}`] : []),
    ...pastShows.map((s) => `/shows/${s.id}`),
    ...memberIds.map((id) => `/members/${id}`),
    ...news.map((n) => `/news/${n.id}`),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((path) => `  <url><loc>${base}${path}</loc></url>`).join('\n')}
</urlset>`;

  return c.body(body, 200, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  });
});

systemRoutes.get('/robots.txt', (c) => {
  const base = c.env.SITE_URL.replace(/\/$/, '');
  return c.text(
    ['User-agent: *', 'Allow: /', 'Disallow: /admin', 'Disallow: /api/', '', `Sitemap: ${base}/sitemap.xml`].join('\n'),
    200,
    { 'Content-Type': 'text/plain; charset=utf-8' },
  );
});

/**
 * Unsubscribe confirmation.
 *
 * A GET renders this page and changes nothing; the POST it submits does the
 * work. Mail clients and security scanners prefetch links, so a GET that
 * unsubscribed on sight would remove people who never clicked.
 */
systemRoutes.get('/newsletter/unsubscribe', async (c) => {
  const token = c.req.query('token') ?? '';
  const subscriber = await findByToken(getDb(c.env.DB), token);

  if (!subscriber || subscriber.unsubscribedAt) {
    c.status(404);
    return c.render(
      <div class="mx-auto max-w-xl px-4 sm:px-6 lg:px-8 py-24 text-center">
        <h1 class="font-display text-3xl font-bold text-neutral-900 mb-3">
          That link is no longer valid
        </h1>
        <p class="text-neutral-600 mb-8">
          It may already have been used. If you are still receiving emails you did not
          ask for, please{' '}
          <a href="/about/contact" class="text-primary-600 hover:text-primary-700">
            contact us
          </a>{' '}
          and we will take you off the list.
        </p>
        <a href="/" class="text-primary-600 hover:text-primary-700">
          Go home
        </a>
      </div>,
      { title: 'Unsubscribe' },
    );
  }

  return c.render(
    <div class="mx-auto max-w-xl px-4 sm:px-6 lg:px-8 py-24 text-center">
      <h1 class="font-display text-3xl font-bold text-neutral-900 mb-3">
        Unsubscribe from our newsletter?
      </h1>
      <p class="text-neutral-600 mb-8">
        We will stop sending updates to <strong>{subscriber.email}</strong>. You can
        subscribe again at any time.
      </p>
      <form method="post" action="/api/newsletter/unsubscribe">
        <input type="hidden" name="token" value={token} />
        <button
          type="submit"
          class="px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-lg transition-colors"
        >
          Yes, unsubscribe me
        </button>
      </form>
      <a href="/" class="inline-block mt-6 text-sm text-neutral-500 hover:text-neutral-700">
        No, keep me subscribed
      </a>
    </div>,
    { title: 'Unsubscribe' },
  );
});

systemRoutes.get('/newsletter/unsubscribed', (c) =>
  c.render(
    <div class="mx-auto max-w-xl px-4 sm:px-6 lg:px-8 py-24 text-center">
      <h1 class="font-display text-3xl font-bold text-neutral-900 mb-3">
        You have been unsubscribed
      </h1>
      <p class="text-neutral-600 mb-8">
        We will not send you any more newsletters. Thank you for supporting the Drama
        Club.
      </p>
      <a href="/" class="text-primary-600 hover:text-primary-700">
        Go home
      </a>
    </div>,
    { title: 'Unsubscribed' },
  ),
);

/**
 * Privacy policy and terms.
 *
 * Google requires both to publish an OAuth consent screen, but the reason to
 * get them right is that this site publishes information about minors. Every
 * statement below is checked against what the code does - the data listed is
 * the data the schema holds, the third parties listed are the bindings in
 * wrangler.jsonc, and the retention section says plainly that audit rows are
 * kept indefinitely, because no purge has been built.
 */

const LEGAL_UPDATED = 'August 8, 2026';

const Section = ({ title, children }: { title: string; children?: unknown }) => (
  <section>
    <h2 class="font-display text-xl font-semibold text-neutral-900 mt-8 mb-2">{title}</h2>
    {children}
  </section>
);

systemRoutes.get('/privacy', (c) =>
  c.render(
    <div class="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-16">
      <h1 class="font-display text-4xl font-bold text-neutral-900 mb-2">Privacy Policy</h1>
      <p class="text-sm text-neutral-500 mb-8">Last updated {LEGAL_UPDATED}</p>

      <div class="space-y-4 text-neutral-600">
        <p>
          This site is run by the Fairport Drama Club Boosters, a volunteer parent
          organization supporting student theater at Fairport High School. We are not the
          Fairport Central School District. This policy explains what we collect, why, and
          how to have it removed.
        </p>

        <Section title="Information about students">
          <p>
            Students who have appeared in one of our productions are listed by name, with a
            photograph and biography where we have them, as they appeared in the printed
            program. Every other student is listed by first name and last initial only,
            with no photograph, no biography, and no page of their own. Any student may
            change this themselves at any time, in either direction, and choosing to show
            less takes effect immediately. The{' '}
            <a href="/disclaimer" class="text-primary-600 hover:text-primary-700">
              disclaimer
            </a>{' '}
            describes this in more detail.
          </p>
          <p class="mt-3">
            A student or parent may ask a board member to take a student's information
            down. We remove the photograph, biography, and surname. Where a student
            appeared in a past production, their first name and last initial remain against
            the role they played, because that is the record of who performed in the show.
            If you would like that removed as well, ask and we will talk it through.
          </p>
        </Section>

        <Section title="What we collect">
          <ul class="space-y-3 mt-2">
            <li>
              <strong class="text-neutral-800">Newsletter sign-ups.</strong> Your email
              address, optionally a name, and when you subscribed. We do not currently send
              a newsletter from this site at all; these addresses are collected and stored,
              nothing more. Every message we eventually send will carry an unsubscribe link,
              and you can ask us to remove you at any time.
            </li>
            <li>
              <strong class="text-neutral-800">Contact form messages.</strong> Your name,
              email address, chosen subject, and message. These are emailed to the Boosters
              board and are not stored on this site.
            </li>
            <li>
              <strong class="text-neutral-800">Accounts.</strong> Only for the small number
              of people who edit the site. We store an email address, a display name, the
              permissions granted, and sign-in sessions. Accounts are by invitation only.
            </li>
            <li>
              <strong class="text-neutral-800">A record of changes.</strong> When somebody
              with an account changes something, we record what changed, when, who did it,
              and the IP address and browser used. This exists so that changes to student
              information can be attributed accurately, particularly where school devices
              and logins are shared.
            </li>
          </ul>
          <p class="mt-4">
            We do not use analytics, advertising, or third-party tracking of any kind. There
            are no cookies on this site except a single sign-in cookie, and only for people
            who have an account and are signed in.
          </p>
        </Section>

        <Section title="Who else sees it">
          <p>
            <strong class="text-neutral-800">Cloudflare</strong> hosts this site and stores
            its database, images, and email delivery. Everything above passes through their
            systems.{' '}
            <strong class="text-neutral-800">Google</strong> sees your email address and
            basic profile only if you choose to sign in with a Google account; we request
            nothing beyond your name and email, and no access to any other Google service.
          </p>
          <p class="mt-3">
            We do not sell information, share it for advertising, or give it to anyone else,
            including the school district.
          </p>
        </Section>

        <Section title="How long we keep it">
          <p>
            Newsletter addresses are kept until you unsubscribe or ask to be removed. When
            you unsubscribe we keep the row so the address is not accidentally added again,
            and we stop using it.
          </p>
          <p class="mt-3">
            The record of changes described above is currently kept indefinitely. We have
            not yet built a routine that deletes old entries. We are telling you that
            plainly rather than implying a schedule we do not have; if you would like your
            entries removed sooner, ask.
          </p>
        </Section>

        <Section title="Children">
          <p>
            This site is about a high school drama club, and most students involved are
            between fourteen and eighteen. It is not directed at children under thirteen and
            we do not knowingly collect information from them. A parent or guardian may ask
            us to remove any information about their child, and we will.
          </p>
        </Section>

        <Section title="Asking us to remove something">
          <p>
            Write to us through the{' '}
            <a href="/about/contact" class="text-primary-600 hover:text-primary-700">
              contact form
            </a>
            . A real person on the Boosters board reads it. You do not need to give a reason.
          </p>
        </Section>

        <Section title="Changes">
          <p>
            If we change this policy we will update the date at the top. Material changes to
            how student information is published will be raised with the club rather than
            made quietly.
          </p>
        </Section>
      </div>
    </div>,
    {
      title: 'Privacy Policy',
      description: 'What the Fairport Drama Club Boosters collect, why, and how to have it removed.',
    },
  ),
);

systemRoutes.get('/terms', (c) =>
  c.render(
    <div class="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-16">
      <h1 class="font-display text-4xl font-bold text-neutral-900 mb-2">Terms of Use</h1>
      <p class="text-sm text-neutral-500 mb-8">Last updated {LEGAL_UPDATED}</p>

      <div class="space-y-4 text-neutral-600">
        <p>
          This site is operated by the Fairport Drama Club Boosters, a volunteer parent
          organization supporting student theater at Fairport High School. By using it you
          agree to what follows. It is written to be read, not to be impressive.
        </p>

        <Section title="What this site is">
          <p>
            An information site about the club: our productions, the students in them, news,
            and how to support us. Nothing is sold here. Tickets are sold through a separate
            service that we link to, and spirit wear is listed so you know what exists, not
            purchased on this site.
          </p>
        </Section>

        <Section title="Accounts">
          <p>
            Accounts exist only for club members, officers, staff, and board members who
            maintain the site, and are created by invitation. There is no public sign-up. Do
            not share your sign-in link or let somebody else use your account: every change
            is recorded against whoever is signed in, and that record is how we sort out
            questions later.
          </p>
          <p class="mt-3">
            We may remove access at any time, usually because somebody has left the club.
            Removing access does not remove a student's profile or their credit in a past
            production.
          </p>
        </Section>

        <Section title="What you post">
          <p>
            If you write a biography or upload a photograph, you are confirming that it is
            yours to share and that anybody appearing in a photograph is willing to appear
            on a public website. Keep it about theater and about the club.
          </p>
          <p class="mt-3">
            Student biographies and photographs are reviewed before they appear publicly.
            Officers and board members may edit or remove anything on the site, and will
            remove content that is inappropriate, that identifies someone who does not want
            to be identified, or that somebody has asked us to take down.
          </p>
        </Section>

        <Section title="Using the site">
          <p>
            Do not try to break into it, scrape it, overload it, or use it to contact
            students. Do not copy photographs of students from this site and republish them
            elsewhere. Show titles, scripts, logos, and production artwork belong to their
            respective rights holders and appear here to describe our productions.
          </p>
        </Section>

        <Section title="No warranty">
          <p>
            We are volunteers, and we make no promises that this site is always available or
            always correct. Performance dates, ticket links, and cast lists change. Check
            with us if something matters.
          </p>
        </Section>

        <Section title="Privacy and questions">
          <p>
            How we handle information is set out in our{' '}
            <a href="/privacy" class="text-primary-600 hover:text-primary-700">
              privacy policy
            </a>
            . For anything else, use the{' '}
            <a href="/about/contact" class="text-primary-600 hover:text-primary-700">
              contact form
            </a>
            .
          </p>
        </Section>
      </div>
    </div>,
    {
      title: 'Terms of Use',
      description: 'Terms for using the Fairport High School Drama Club website.',
    },
  ),
);

systemRoutes.get('/disclaimer', (c) =>
  c.render(
    <div class="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-16">
      <h1 class="font-display text-4xl font-bold text-neutral-900 mb-6">Disclaimer</h1>

      <div class="space-y-6 text-neutral-600">
        <p>
          This site is operated by the Fairport Drama Club Boosters, an independent
          community volunteer organization. It is not an official publication of the
          Fairport Central School District, and the District is not responsible for its
          content.
        </p>

        <section>
          <h2 class="font-display text-xl font-semibold text-neutral-900 mb-2">
            Student Privacy
          </h2>
          <p>
            Students who have appeared in one of our productions are listed here by name,
            with their photograph and biography where we have them, in the same way they
            appeared in the printed program and on the display outside the theater.
          </p>
          <p>
            Every other student &mdash; anyone who has not appeared in a production, and
            everyone who joins from now on &mdash; is listed by first name and last
            initial only, with no photograph, no biography, and no individual profile
            page, unless they choose otherwise.
          </p>
          <p>
            Any student may change this at any time, in either direction, without asking
            anyone. Choosing to be listed by first name and last initial takes effect
            immediately.
          </p>
          <p>
            A student may also ask a board member to take their information down. We
            remove the photograph, biography, and surname. Where a student appeared in a
            past production, their first name and last initial remain against the role
            they played &mdash; that is the record of who performed in the show, and the
            printed program is otherwise its only copy. If you would like that removed as
            well, please ask and we will talk it through.
          </p>
        </section>

        <section>
          <h2 class="font-display text-xl font-semibold text-neutral-900 mb-2">
            Information We Record
          </h2>
          <p>
            For accounts used to edit this site, we keep a record of every change: what was
            changed, when, by whom, and the IP address and browser used. This exists so
            that changes to student information can be attributed accurately, particularly
            where devices and logins are shared. These records are visible to Boosters
            board members, and any account holder can view the record of changes they made
            and of changes made to their own profile. Our{' '}
            <a href="/privacy" class="text-primary-600 hover:text-primary-700">
              privacy policy
            </a>{' '}
            covers everything else we collect, and how long we keep it.
          </p>
        </section>

        <section>
          <h2 class="font-display text-xl font-semibold text-neutral-900 mb-2">
            Contact
          </h2>
          <p>
            To request a correction or removal, or to ask about anything above, please{' '}
            <a href="/about/contact" class="text-primary-600 hover:text-primary-700">
              contact us
            </a>
            .
          </p>
        </section>
      </div>
    </div>,
    { title: 'Disclaimer', description: 'Site operator, student privacy, and record-keeping.' },
  ),
);

/**
 * 404. Registered last so it only catches genuinely unmatched paths.
 *
 * Deliberately identical for a member who does not exist and one who has not
 * opted in, so the page cannot be used to discover which is which.
 */
export const notFound = (c: Parameters<Parameters<Hono<AppEnv>['notFound']>[0]>[0]) => {
  // c.render() defaults to 200. Without this the page looks correct but is
  // served as a success, so crawlers would index every mistyped URL.
  c.status(404);
  return c.render(
    <div class="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8 py-24 text-center">
      <p class="text-6xl mb-4" aria-hidden="true">
        🎭
      </p>
      <h1 class="font-display text-4xl font-bold text-neutral-900 mb-3">Page Not Found</h1>
      <p class="text-neutral-600 mb-8">
        We could not find that page. It may have moved, or never existed.
      </p>
      <div class="flex flex-col sm:flex-row gap-3 justify-center">
        <a
          href="/"
          class="inline-flex items-center justify-center px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-lg transition-colors"
        >
          Go Home
        </a>
        <a
          href="/shows/past"
          class="inline-flex items-center justify-center px-6 py-3 bg-neutral-100 hover:bg-neutral-200 text-neutral-800 font-semibold rounded-lg transition-colors"
        >
          Browse Shows
        </a>
      </div>
    </div>,
    { title: 'Page Not Found' },
  );
};

/**
 * 500.
 *
 * Registered because there was nothing: a query that threw took the whole
 * response with it, so the visitor got the runtime's own error page and the
 * log got a stack with no reason attached. Both halves are fixed here - the
 * cause chain is unwrapped into the log, and the visitor gets a page.
 *
 * The handler must not throw. Everything it touches is either the context or
 * already in memory.
 */
export const serverError = (
  err: Parameters<Parameters<Hono<AppEnv>['onError']>[0]>[0],
  c: Parameters<Parameters<Hono<AppEnv>['onError']>[0]>[1],
) => {
  // Logged as an object, not an interpolated string: Workers Logs indexes the
  // fields, so `causes` stays filterable rather than being buried in a message.
  console.error({ path: c.req.path, ...describeError(err) });

  // The JSON endpoints are mounted ahead of the layout and are called by
  // fetch, not followed by a browser. An HTML error page is unparseable there.
  if (c.req.path.startsWith('/api/')) {
    return c.json({ success: false, error: 'Something went wrong. Please try again.' }, 500);
  }

  c.status(500);
  return c.render(
    <div class="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8 py-24 text-center">
      <h1 class="font-display text-4xl font-bold text-neutral-900 mb-3">Something Went Wrong</h1>
      <p class="text-neutral-600 mb-8">
        This one is on us, not on you. Please try again in a moment.
      </p>
      <a
        href="/"
        class="inline-flex items-center justify-center px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-lg transition-colors"
      >
        Go Home
      </a>
    </div>,
    { title: 'Something Went Wrong' },
  );
};

/**
 * Dev-only image delivery.
 *
 * Serves bytes held by the local KV shim. Registered unconditionally but a
 * no-op in production, where the store is Cloudflare Images and never returns
 * bytes through the Worker - delivery URLs point at imagedelivery.net instead,
 * so nothing routes here.
 */
systemRoutes.get('/dev/images/:id/:variant', async (c) => {
  const store = c.get('images');
  const image = await store.get(c.req.param('id'));
  if (!image) return c.notFound();

  return c.body(image.body, 200, {
    'Content-Type': image.contentType,
    // Short cache: local images are replaced during development, and a long
    // cache would hide that.
    'Cache-Control': 'public, max-age=60',
  });
});
