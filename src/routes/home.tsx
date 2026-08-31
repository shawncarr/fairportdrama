import { Hono } from 'hono';
import type { AppEnv } from '~/env';
import {
  getDb,
  getLastClosedAnnouncedShow,
  getPastShows,
  getPerformances,
  getPromotedShows,
  getPublishedNews,
  getSponsors,
} from '~/db/queries';
import { CountdownTimer, countdownScript } from '~/components/CountdownTimer';
import { NewsletterForm } from '~/components/NewsletterForm';
import { ShowCard, toShowCardView } from '~/components/ShowCard';
import { SponsorGrid, type SponsorView } from '~/components/SponsorGrid';
import { IMAGE_VARIANT, ogImageUrl } from '~/lib/images';
import { showDateLine, formatDate } from '~/lib/dates';
import { SHOW_COMPANY_LABEL } from '~/services/shows';

export const home = new Hono<AppEnv>();

home.get('/', async (c) => {
  const db = getDb(c.env.DB);
  const images = c.get('images');

  const promoted = await getPromotedShows(db);
  const [hero, ...alsoThisSeason] = promoted;

  // With nothing upcoming the page keeps naming the show that just ran, in
  // its wrap state. Emptying the hero the morning after closing night would
  // be more surprising than marking the run over.
  const featured = hero ?? (await getLastClosedAnnouncedShow(db));
  const closed = !hero && featured !== null;

  const [performances, pastShows, latestNews, sponsors] = await Promise.all([
    featured ? getPerformances(db, featured.id) : Promise.resolve([]),
    getPastShows(db),
    getPublishedNews(db, 3),
    getSponsors(db, { showId: null }),
  ]);

  // Only the wrap hero can collide. `getPastShows` returns closed runs and
  // `getPromotedShows` returns runs that have not closed, so the two sets are
  // disjoint by construction - spreading `promoted` in here would filter
  // nothing and read as an invariant the code cannot actually enforce.
  const promotedIds = new Set(featured ? [featured.id] : []);

  /**
   * Past productions for the home page.
   *
   * Every promoted show is dropped, hero included: a closed run counts as
   * finished, so without the filter the page listed the same production
   * twice. Highlighting orders rather than filters - the section used to
   * show only flagged shows, and with one flag set across four productions it
   * had collapsed to a single card that was also the hero.
   */
  const homePastShows = pastShows
    .filter((s) => !promotedIds.has(s.id))
    .sort(
      (a, b) =>
        Number(b.isHighlighted) - Number(a.isHighlighted) ||
        (b.lastPerformance ?? '') < (a.lastPerformance ?? '')
          ? -1
          : (b.lastPerformance ?? '') > (a.lastPerformance ?? '')
            ? 1
            : 0,
    )
    .slice(0, 3);

  const heroUrl = images.deliveryUrl(featured?.heroImageId, IMAGE_VARIANT.Hero);

  return c.render(
    <>
      {featured ? (
        <section class="relative bg-gradient-to-br from-primary-600 via-primary-700 to-secondary-800 text-white overflow-hidden">
          {heroUrl && (
            <div class="absolute inset-0" aria-hidden="true">
              <img src={heroUrl} alt="" class="w-full h-full object-cover opacity-50" />
              <div class="absolute inset-0 bg-gradient-to-br from-primary-600/80 via-primary-700/80 to-secondary-800/90" />
            </div>
          )}

          <div class="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-20 lg:py-32">
            <div class="grid lg:grid-cols-2 gap-12 items-center">
              <div class="text-center lg:text-left">
                <p class="text-accent-400 font-semibold text-sm uppercase tracking-wider mb-4">
                  {featured.season}
                  {featured.company && (
                    <span class="ml-2 px-2 py-0.5 rounded-full bg-white/20 text-white text-xs font-medium">
                      {SHOW_COMPANY_LABEL[featured.company]}
                    </span>
                  )}
                  {closed && (
                    <span class="ml-2 text-white/60 normal-case tracking-normal font-normal">
                      &middot; This run has ended
                    </span>
                  )}
                </p>
                <h1 class="font-display text-4xl sm:text-5xl lg:text-6xl font-bold mb-4">
                  {featured.title}
                </h1>
                <p class="text-white/70 mb-8 max-w-xl mx-auto lg:mx-0">
                  {featured.synopsis}
                </p>

                <div class="flex flex-wrap gap-4 justify-center lg:justify-start mb-8 text-sm">
                  <div class="flex items-center gap-2">
                    <CalendarIcon />
                    <span>{showDateLine(featured.firstPerformance, featured.lastPerformance)}</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <PinIcon />
                    <span>{featured.venue}</span>
                  </div>
                </div>

                <div class="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start">
                  {/* A finished run never shows a ticket link. Selling tickets
                      to a show that already closed is worse than showing
                      nothing, and the stored isAnnounced flag cannot be relied
                      on to have been cleared. */}
                  {closed ? (
                    <a
                      href="/shows"
                      class="inline-flex items-center justify-center px-8 py-3 bg-white/10 hover:bg-white/20 text-white font-semibold rounded-lg transition-colors backdrop-blur-sm"
                    >
                      Browse Past Shows
                    </a>
                  ) : featured.ticketUrl ? (
                    <a
                      href={featured.ticketUrl}
                      class="inline-flex items-center justify-center px-8 py-3 bg-accent-500 hover:bg-accent-600 text-neutral-900 font-semibold rounded-lg transition-colors shadow-lg hover:shadow-xl"
                    >
                      Get Tickets
                    </a>
                  ) : (
                    <span class="inline-flex items-center justify-center px-8 py-3 bg-white/20 text-white font-semibold rounded-lg cursor-default">
                      Tickets Coming Soon
                    </span>
                  )}
                  <a
                    href={`/shows/${featured.id}`}
                    class="inline-flex items-center justify-center px-8 py-3 bg-white/10 hover:bg-white/20 text-white font-semibold rounded-lg transition-colors backdrop-blur-sm"
                  >
                    Learn More
                  </a>
                </div>
              </div>

              {/* Counting down to a date that has passed is noise, so a closed
                  run gets a closing note in the same slot instead. */}
              {closed ? (
                <div class="flex justify-center lg:justify-end">
                  <div class="bg-white/10 backdrop-blur-sm rounded-2xl p-8 text-center max-w-sm">
                    <p class="font-display text-2xl font-bold text-white mb-2">
                      That&rsquo;s a wrap
                    </p>
                    <p class="text-white/70 text-sm">
                      {featured.title} closed on{' '}
                      {formatDate(featured.lastPerformance ?? '')}. Thank you to
                      everyone who came out.
                    </p>
                    <a
                      href={`/shows/${featured.id}`}
                      class="inline-block mt-4 text-accent-400 hover:text-accent-300 text-sm font-medium"
                    >
                      See the cast and crew
                    </a>
                  </div>
                </div>
              ) : (
                performances.length > 0 && (
                  <div class="flex justify-center lg:justify-end">
                    <CountdownTimer
                      targetDate={performances[0]!.date}
                      showTitle={featured.title}
                    />
                  </div>
                )
              )}
            </div>
          </div>

          <div class="absolute bottom-0 left-0 right-0">
            <svg
              class="w-full h-16 text-neutral-50"
              preserveAspectRatio="none"
              viewBox="0 0 1440 74"
            >
              <path
                fill="currentColor"
                d="M0,32L48,37.3C96,43,192,53,288,58.7C384,64,480,64,576,58.7C672,53,768,43,864,42.7C960,43,1056,53,1152,53.3C1248,53,1344,43,1392,37.3L1440,32L1440,74L1392,74C1344,74,1248,74,1152,74C1056,74,960,74,864,74C768,74,672,74,576,74C480,74,384,74,288,74C192,74,96,74,48,74L0,74Z"
              />
            </svg>
          </div>
        </section>
      ) : (
        <section class="relative bg-gradient-to-br from-primary-600 via-primary-700 to-secondary-800 text-white py-20 lg:py-32">
          <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
            <h1 class="font-display text-4xl sm:text-5xl lg:text-6xl font-bold mb-4">
              Fairport Drama Club
            </h1>
            <p class="text-white/80 max-w-2xl mx-auto">
              Our next production has not been announced yet. Check back soon, or
              subscribe below to hear first.
            </p>
          </div>
        </section>
      )}

      {alsoThisSeason.length > 0 && (
        <section class="py-12 bg-neutral-50 border-b border-neutral-200">
          <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 class="font-display text-2xl font-bold text-neutral-900 mb-6">
              Also this season
            </h2>
            <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {alsoThisSeason.map((show) => (
                <ShowCard show={toShowCardView(show, images)} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/*
        What this website is, immediately under the hero.

        Sized and placed deliberately. Google's OAuth review refused
        verification for a home page that "does not explain the purpose of your
        app" twice while a shorter version of this was live - first at the
        bottom of the page, then as a one-line band. A reviewer arriving at the
        root of a drama club's site sees show promotion and stops, so the
        explanation has to be the first thing after the hero and has to be
        substantial enough to read as the answer.

        It earns its place for visitors too: nothing else on the site says who
        publishes it or how a student gets an account.
      */}
      <section class="py-14 lg:py-20 bg-white border-b border-neutral-200">
        <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 class="font-display text-3xl lg:text-4xl font-bold text-neutral-900 mb-4">
            About This Website
          </h2>
          <p class="text-lg text-neutral-700 max-w-3xl leading-relaxed mb-4">
            <strong>Fairport Drama is the official website of the Fairport High School
            Drama Club</strong> in Fairport, New York. It is published by the Drama Club
            Boosters, a volunteer parent organization supporting student theater, and it is
            written and kept up to date by the club&rsquo;s own students and volunteers
            rather than by an outside webmaster.
          </p>
          <p class="text-neutral-700 max-w-3xl leading-relaxed mb-10">
            Anyone can read it without an account. Behind it is a members&rsquo; area where
            the club maintains everything you see here.
          </p>

          <div class="grid gap-8 md:grid-cols-3 mb-10">
            <div>
              <h3 class="font-display text-lg font-semibold text-neutral-900 mb-2">
                What you will find here
              </h3>
              <p class="text-sm text-neutral-600 leading-relaxed">
                Current and past productions, performance dates and ticket links, cast and
                crew for every show, club news and audition notices, member profiles,
                sponsors, and spirit wear.
              </p>
            </div>

            <div>
              <h3 class="font-display text-lg font-semibold text-neutral-900 mb-2">
                Run by the club itself
              </h3>
              <p class="text-sm text-neutral-600 leading-relaxed">
                Cast and crew, student officers, and the adults who help run the club sign
                in to post news, build cast and crew lists, upload production photographs,
                maintain the member roster, and edit their own profile. Signing in is by
                Google account or an emailed link, and access is by invitation only -
                signing in does not create an account.
              </p>
            </div>

            <div>
              <h3 class="font-display text-lg font-semibold text-neutral-900 mb-2">
                Students control their own listing
              </h3>
              <p class="text-sm text-neutral-600 leading-relaxed">
                Most of our members are minors, so every member profile starts private: a
                first name and last initial, with no photograph and no page of their own.
                Each student decides for themselves whether to appear in full, and can
                change it back at any time.
              </p>
            </div>
          </div>

        </div>
      </section>

      {latestNews.length > 0 && (
        <section class="py-16 lg:py-24 bg-neutral-50">
          <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div class="flex items-center justify-between mb-10">
              <h2 class="font-display text-3xl lg:text-4xl font-bold text-neutral-900">
                Latest News
              </h2>
              <a
                href="/news"
                class="text-primary-600 hover:text-primary-700 font-medium text-sm"
              >
                All news
              </a>
            </div>
            <div class="grid gap-8 md:grid-cols-3">
              {latestNews.map((post) => (
                <article class="bg-white rounded-xl ring-1 ring-neutral-200 overflow-hidden hover:ring-primary-300 transition-all">
                  <div class="p-6">
                    <time class="text-xs uppercase tracking-wide text-neutral-500">
                      {formatDate(post.publishedAt)}
                    </time>
                    <h3 class="font-display text-lg font-semibold text-neutral-900 mt-2 mb-2">
                      <a href={`/news/${post.id}`} class="hover:text-primary-600">
                        {post.title}
                      </a>
                    </h3>
                    <p class="text-sm text-neutral-600">{post.excerpt}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}

      {homePastShows.length > 0 && (
        <section class="py-16 lg:py-24 bg-white">
          <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div class="flex items-center justify-between mb-10">
              <h2 class="font-display text-3xl lg:text-4xl font-bold text-neutral-900">
                Past Productions
              </h2>
              <a
                href="/shows"
                class="text-primary-600 hover:text-primary-700 font-medium text-sm"
              >
                All shows
              </a>
            </div>
            <div class="grid gap-8 md:grid-cols-3">
              {homePastShows.map((show) => {
                const poster = images.deliveryUrl(show.posterImageId, IMAGE_VARIANT.Poster);
                return (
                  <a
                    href={`/shows/${show.id}`}
                    class="group block rounded-xl overflow-hidden ring-1 ring-neutral-200 hover:ring-primary-300 transition-all"
                  >
                    <div class="aspect-[16/10] bg-neutral-800 relative">
                      {poster && (
                        <img
                          src={poster}
                          alt=""
                          loading="lazy"
                          class="w-full h-full object-cover opacity-70 group-hover:opacity-90 transition-opacity"
                        />
                      )}
                    </div>
                    <div class="p-5">
                      <h3 class="font-display font-semibold text-neutral-900">
                        {show.title}
                      </h3>
                      <p class="text-sm text-neutral-500">{show.season}</p>
                    </div>
                  </a>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {sponsors.length > 0 && (
        <section class="py-16 lg:py-24 bg-neutral-50">
          <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div class="text-center mb-10">
              <h2 class="font-display text-3xl lg:text-4xl font-bold text-neutral-900">
                Our Sponsors
              </h2>
              <p class="text-neutral-600 mt-2">
                Local businesses that make our productions possible.
              </p>
            </div>
            <SponsorGrid sponsors={sponsors as SponsorView[]} images={images} />
            <div class="text-center mt-8">
              <a
                href="/about/sponsors"
                class="text-primary-600 hover:text-primary-700 font-medium text-sm"
              >
                Become a sponsor
              </a>
            </div>
          </div>
        </section>
      )}

      <section class="py-16 lg:py-24 bg-gradient-to-r from-primary-600 to-secondary-700 text-white">
        <div class="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 text-center">
          <h2 class="font-display text-3xl lg:text-4xl font-bold mb-4">
            Never Miss a Show
          </h2>
          <p class="text-white/80 mb-8">
            Get notified about upcoming productions, auditions, and club news.
          </p>
          <NewsletterForm variant="hero" />
        </div>
      </section>

      {/*
        How the app uses Google sign-in, in small print at the foot of the page.

        Google's App Homepage requirements ask the registered home page to
        "explain with transparency the purpose for which your app requests user
        data", and the automated check does not follow links - so it has to be
        on this page. It does not have to be at the top: the check failed with
        it there too, so position was never the lever. This keeps the page's
        first screens about the club while the page still says it.
      */}
      <section class="bg-neutral-50 border-t border-neutral-200">
        <div class="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-8">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
            Signing in with Google
          </h2>
          <p class="text-xs text-neutral-500 leading-relaxed">
            When a member signs in with Google, Fairport Drama requests only their email
            address and basic profile information. It uses them for a single purpose: to
            match the person signing in to the invitation that granted them access, so that
            only invited members reach the members&rsquo; area. Nothing else is read from a
            Google account, no Google data is used for advertising, and none of it is sold
            or shared. Members can also sign in without Google, using a link sent to their
            email address. See our{' '}
            <a href="/privacy" class="text-neutral-600 hover:text-neutral-800 underline">
              privacy policy
            </a>{' '}
            for what the site stores and how to have it removed, or{' '}
            <a href="/about/website" class="text-neutral-600 hover:text-neutral-800 underline">
              more about this website
            </a>
            .
          </p>
        </div>
      </section>

      {!closed && performances.length > 0 && countdownScript()}
    </>,
    {
      title: 'Home',
      description: featured
        ? `${featured.title} - ${featured.season}. ${featured.synopsis}`
        : undefined,
      image:
        ogImageUrl(images, {
          og: featured?.ogImageId,
          hero: featured?.heroImageId,
          poster: featured?.posterImageId,
        }) ?? undefined,
    },
  );
});

const CalendarIcon = () => (
  <svg class="h-5 w-5 text-accent-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
    />
  </svg>
);

const PinIcon = () => (
  <svg class="h-5 w-5 text-accent-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
    />
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
    />
  </svg>
);
