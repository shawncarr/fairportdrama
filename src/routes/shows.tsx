import { Hono } from 'hono';
import type { AppEnv } from '~/env';
import {
  getCast,
  getCrew,
  getDb,
  getGallery,
  getPastShows,
  getPerformances,
  getPromotedShows,
  getShow,
  getSponsors,
} from '~/db/queries';
import { ShowCard } from '~/components/ShowCard';
import { SponsorGrid, type SponsorView } from '~/components/SponsorGrid';
import { ShareButtons } from '~/components/ShareButtons';
import { PhotoGallery } from '~/components/PhotoGallery';
import { IMAGE_VARIANT, ogImageUrl } from '~/lib/images';
import { hasClosed, showDateLine } from '~/lib/dates';
import { can } from '~/lib/auth/permissions';
import { SHOW_COMPANY_LABEL } from '~/services/shows';
import type { ShowCastTier } from '~/db/schema/content';

export const showRoutes = new Hono<AppEnv>();

const TIER_HEADINGS: Record<ShowCastTier, string> = {
  lead: 'Leading Roles',
  supporting: 'Supporting Cast',
  ensemble: 'Ensemble',
};

const TIER_ORDER: ShowCastTier[] = ['lead', 'supporting', 'ensemble'];

showRoutes.get('/shows/current', async (c) => {
  const [next] = await getPromotedShows(getDb(c.env.DB));
  return next ? c.redirect(`/shows/${next.id}`, 302) : c.redirect('/shows', 302);
});

// Permanent: /shows/past was indexed, and it is being folded into /shows
// rather than moved.
showRoutes.get('/shows/past', (c) => c.redirect('/shows', 301));

showRoutes.get('/shows', async (c) => {
  const db = getDb(c.env.DB);
  const images = c.get('images');
  const [upcoming, past] = await Promise.all([getPromotedShows(db), getPastShows(db)]);

  const toCard = (show: (typeof past)[number]) => ({
    id: show.id,
    title: show.title,
    season: show.season,
    company: show.company,
    posterUrl: images.deliveryUrl(show.posterImageId, IMAGE_VARIANT.Poster),
    firstPerformance: show.firstPerformance,
    lastPerformance: show.lastPerformance,
  });

  return c.render(
    <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16 space-y-16">
      <h1 class="font-display text-4xl font-bold text-neutral-900">Shows</h1>

      {upcoming.length > 0 && (
        <section>
          <h2 class="font-display text-3xl font-bold text-neutral-900 mb-8">Upcoming</h2>
          <div class="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {upcoming.map((show) => (
              <ShowCard show={toCard(show)} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 class="font-display text-3xl font-bold text-neutral-900 mb-3">
          Past Productions
        </h2>
        <p class="text-neutral-600 mb-8">A look back at what the Drama Club has staged.</p>
        {past.length === 0 ? (
          <p class="text-neutral-600">No past productions have been added yet.</p>
        ) : (
          <div class="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {past.map((show) => (
              <ShowCard show={toCard(show)} dates={false} />
            ))}
          </div>
        )}
      </section>
    </div>,
    {
      title: 'Shows',
      description: 'Upcoming and past productions staged by the Fairport Drama Club.',
    },
  );
});

showRoutes.get('/shows/:slug', async (c) => {
  const db = getDb(c.env.DB);
  const images = c.get('images');
  const show = await getShow(db, c.req.param('slug'));
  if (!show) return c.notFound();
  // A draft is hidden from visitors, not from the board member building it.
  // Nothing in the admin links to a show's public page, so 404ing everyone
  // would leave no way to check a page before announcing it - and announcing
  // is the only other way to see it, which publishes it to the home page.
  if (show.isDraft && !can(c.get('role') ?? null, 'show', 'update')) {
    return c.notFound();
  }

  const [performances, cast, crew, gallery, sponsors] = await Promise.all([
    getPerformances(db, show.id),
    getCast(db, show.id),
    getCrew(db, show.id),
    getGallery(db, show.id),
    getSponsors(db, { showId: show.id }),
  ]);

  const closed = hasClosed(performances);

  const heroUrl = images.deliveryUrl(show.heroImageId, IMAGE_VARIANT.Hero);
  const posterUrl = images.deliveryUrl(show.posterImageId, IMAGE_VARIANT.Poster);

  // The Astro version rendered this entire page twice - once in a red gradient
  // for the current show and once in grey for past ones - which is most of why
  // that file reached 960 lines. The only real difference is the palette.
  const gradient =
    show.isAnnounced && !closed
      ? 'from-primary-600 via-primary-700 to-secondary-800'
      : 'from-neutral-800 via-neutral-700 to-neutral-900';

  const shareUrl = new URL(`/shows/${show.id}`, c.env.SITE_URL).toString();

  return c.render(
    <>
      <section class={`relative bg-gradient-to-br ${gradient} text-white overflow-hidden`}>
        {heroUrl && (
          <div class="absolute inset-0" aria-hidden="true">
            <img src={heroUrl} alt="" class="w-full h-full object-cover opacity-50" />
            <div class={`absolute inset-0 bg-gradient-to-br ${gradient} opacity-80`} />
          </div>
        )}

        <div class="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16 lg:py-24">
          <div class="grid lg:grid-cols-3 gap-12 items-start">
            <div class="lg:col-span-2">
              <p class="text-accent-400 font-semibold text-sm uppercase tracking-wider mb-3">
                {show.season}
                {show.company && (
                  <span class="ml-2 px-2 py-0.5 rounded-full bg-white/20 text-white text-xs font-medium">
                    {SHOW_COMPANY_LABEL[show.company]}
                  </span>
                )}
              </p>
              <h1 class="font-display text-4xl sm:text-5xl lg:text-6xl font-bold mb-6">
                {show.title}
              </h1>
              <p class="text-white/80 mb-8 max-w-2xl">{show.synopsis}</p>

              <dl class="grid sm:grid-cols-2 gap-4 text-sm mb-8">
                <div>
                  <dt class="text-white/60 uppercase text-xs tracking-wide">Dates</dt>
                  <dd class="mt-1">
                    {showDateLine(show.firstPerformance, show.lastPerformance)}
                  </dd>
                </div>
                <div>
                  <dt class="text-white/60 uppercase text-xs tracking-wide">Venue</dt>
                  <dd class="mt-1">{show.venue}</dd>
                </div>
              </dl>

              {performances.length > 0 && (
                <ul class="text-sm text-white/80 space-y-1 mb-8">
                  {performances.map((p) => (
                    <li>
                      {p.date} &middot; {p.time}
                    </li>
                  ))}
                </ul>
              )}

              {closed && (
                <p class="inline-block px-4 py-2 rounded-lg bg-white/10 text-white/80 text-sm">
                  This run has ended.
                </p>
              )}

              {show.isAnnounced && !closed && show.ticketUrl && (
                <a
                  href={show.ticketUrl}
                  class="inline-flex items-center justify-center px-8 py-3 bg-accent-500 hover:bg-accent-600 text-neutral-900 font-semibold rounded-lg transition-colors shadow-lg"
                >
                  Get Tickets
                </a>
              )}
            </div>

            {posterUrl && (
              <div class="lg:col-span-1">
                <img
                  src={posterUrl}
                  alt={`${show.title} poster`}
                  class="w-full rounded-xl shadow-2xl"
                />
              </div>
            )}
          </div>
        </div>
      </section>

      {cast.length > 0 && (
        <section class="py-16 bg-neutral-50">
          <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 class="font-display text-3xl font-bold text-neutral-900 mb-8 text-center">
              Cast
            </h2>

            {TIER_ORDER.map((tier) => {
              const inTier = cast.filter((c) => c.tier === tier);
              if (inTier.length === 0) return null;
              return (
                <div class="mb-10">
                  <h3 class="font-display text-lg font-semibold text-neutral-700 mb-4">
                    {TIER_HEADINGS[tier]}
                  </h3>
                  <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {inTier.map((entry) => (
                      <li class="bg-white rounded-lg ring-1 ring-neutral-200 px-4 py-3">
                        <p class="font-medium text-neutral-900">
                          {entry.role}
                          {entry.additionalRoles.length > 0 && (
                            <span class="text-neutral-500 font-normal">
                              {' / '}
                              {entry.additionalRoles.join(' / ')}
                            </span>
                          )}
                        </p>
                        <p class="text-sm text-neutral-600">
                          <CastName member={entry.member} />
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {crew.length > 0 && (
        <section class="py-16 bg-white">
          <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 class="font-display text-2xl font-bold text-neutral-900 mb-8 text-center">
              Production Team
            </h2>
            <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {crew.map((entry) => (
                <li class="border-l-2 border-primary-200 pl-4 py-1">
                  <p class="font-medium text-neutral-900">{entry.role}</p>
                  <p class="text-sm text-neutral-600">
                    <CastName member={entry.member} />
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {gallery.length > 0 && (
        <section class="py-16 bg-white">
          <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 class="font-display text-2xl font-bold text-neutral-900 mb-8">Gallery</h2>
            <PhotoGallery
              showTitle={show.title}
              photos={gallery.flatMap((image) => {
                const thumbUrl = images.deliveryUrl(image.imageId, IMAGE_VARIANT.Gallery);
                const fullUrl = images.deliveryUrl(image.imageId, IMAGE_VARIANT.Hero);
                return thumbUrl && fullUrl ? [{ thumbUrl, fullUrl }] : [];
              })}
            />
          </div>
        </section>
      )}

      {sponsors.length > 0 && (
        <section class="py-16 bg-neutral-50">
          <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 class="font-display text-2xl font-bold text-neutral-900 mb-2 text-center">
              Sponsored By
            </h2>
            <p class="text-neutral-600 text-center mb-8">
              This production was made possible by these supporters.
            </p>
            <SponsorGrid sponsors={sponsors as SponsorView[]} images={images} />
          </div>
        </section>
      )}

      <section class="py-12 bg-white">
        <div class="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 text-center">
          <h2 class="font-display text-xl font-bold text-neutral-900 mb-4">
            Share This Show
          </h2>
          <ShareButtons url={shareUrl} title={show.title} />
        </div>
      </section>
    </>,
    {
      title: show.title,
      description: show.synopsis,
      type: 'event',
      image:
        ogImageUrl(images, {
          og: show.ogImageId,
          hero: show.heroImageId,
          poster: show.posterImageId,
        }) ?? undefined,
    },
  );
});

/**
 * A cast or crew credit.
 *
 * `null` means the role is not yet cast. It is shown as TBA rather than
 * omitted, so the audience can see the part exists. Names arrive already
 * reduced to their public form by the query layer, and are only linked when
 * the member has a public profile.
 */
const CastName = ({
  member,
}: {
  member: { name: string; href: string | null } | null;
}) => {
  if (!member) return <span class="italic text-neutral-400">TBA</span>;
  return member.href ? (
    <a href={member.href} class="hover:text-primary-600 transition-colors">
      {member.name}
    </a>
  ) : (
    <span>{member.name}</span>
  );
};
