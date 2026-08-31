import { type ShowCompany } from '~/db/schema/content';
import { IMAGE_VARIANT, type ImageStore } from '~/lib/images';
import { SHOW_COMPANY_LABEL } from '~/services/shows';
import { showDateLine } from '~/lib/dates';

export interface ShowCardView {
  id: string;
  title: string;
  season: string;
  company: ShowCompany | null;
  posterUrl: string | null;
  firstPerformance: string | null;
  lastPerformance: string | null;
}

/**
 * A projected show row, as card props.
 *
 * Lives here rather than in each route so the home page's band and both
 * sections of the shows index cannot drift into three slightly different
 * mappings of the same row.
 */
export const toShowCardView = (
  show: {
    id: string;
    title: string;
    season: string;
    company: ShowCompany | null;
    posterImageId: string | null;
    firstPerformance: string | null;
    lastPerformance: string | null;
  },
  images: ImageStore,
): ShowCardView => ({
  id: show.id,
  title: show.title,
  season: show.season,
  company: show.company,
  posterUrl: images.deliveryUrl(show.posterImageId, IMAGE_VARIANT.Poster),
  firstPerformance: show.firstPerformance,
  lastPerformance: show.lastPerformance,
});

/**
 * One production, as a card.
 *
 * Shared by the home page's concurrent-shows band and both sections of the
 * shows index. `dates` is omitted for the archive, where a run that ended
 * years ago is noise next to the season it belongs to.
 */
export const ShowCard = ({ show, dates = true }: { show: ShowCardView; dates?: boolean }) => (
  <a
    href={`/shows/${show.id}`}
    class="group block rounded-xl overflow-hidden ring-1 ring-neutral-200 hover:ring-primary-300 transition-all bg-white"
  >
    <div class="aspect-[16/10] bg-neutral-800">
      {show.posterUrl && (
        <img
          src={show.posterUrl}
          alt=""
          loading="lazy"
          class="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
        />
      )}
    </div>
    <div class="p-5">
      {show.company && (
        <span class="inline-block mb-2 px-2 py-0.5 rounded-full bg-primary-50 text-primary-700 text-xs font-medium">
          {SHOW_COMPANY_LABEL[show.company]}
        </span>
      )}
      <h3 class="font-display font-semibold text-neutral-900 group-hover:text-primary-600 transition-colors">
        {show.title}
      </h3>
      <p class="text-sm text-neutral-500">{show.season}</p>
      {dates && (
        <p class="mt-1 text-sm text-neutral-600">
          {showDateLine(show.firstPerformance, show.lastPerformance)}
        </p>
      )}
    </div>
  </a>
);
