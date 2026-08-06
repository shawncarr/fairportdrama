import { Hono } from 'hono';
import type { AppEnv } from '~/env';
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
    '/news',
    '/spiritwear',
    '/about/boosters',
    '/about/sponsors',
    '/about/contact',
    '/disclaimer',
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
            and of changes made to their own profile.
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
