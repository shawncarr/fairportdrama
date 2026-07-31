import { IMAGE_VARIANT, imageUrl } from '~/lib/images';
import type { SponsorTier } from '~/db/schema/content';

export interface SponsorView {
  id: string;
  name: string;
  logoImageId: string | null;
  website: string | null;
  tier: SponsorTier;
}

/** Highest to lowest. Drives both display order and heading order. */
export const TIER_ORDER: SponsorTier[] = ['platinum', 'gold', 'silver', 'bronze'];

export const TIER_HEADINGS: Record<SponsorTier, string> = {
  platinum: 'Platinum Sponsors',
  gold: 'Gold Sponsors',
  silver: 'Silver Sponsors',
  bronze: 'Bronze Sponsors',
};

const TIER_SIZES: Record<SponsorTier, string> = {
  platinum: 'h-24 lg:h-28',
  gold: 'h-20 lg:h-24',
  silver: 'h-16 lg:h-20',
  bronze: 'h-14 lg:h-16',
};

function SponsorCard({ sponsor }: { sponsor: SponsorView }) {
  const logo = imageUrl(sponsor.logoImageId, IMAGE_VARIANT.Thumb);

  const inner = (
    <div class="flex items-center justify-center p-6 bg-white rounded-lg ring-1 ring-neutral-200 hover:ring-primary-300 transition-all h-full">
      {logo ? (
        <img
          src={logo}
          alt={sponsor.name}
          loading="lazy"
          class={`${TIER_SIZES[sponsor.tier]} w-auto object-contain`}
        />
      ) : (
        <span class="font-display font-semibold text-neutral-700 text-center">
          {sponsor.name}
        </span>
      )}
    </div>
  );

  return sponsor.website ? (
    <a
      href={sponsor.website}
      target="_blank"
      rel="noopener noreferrer sponsored"
      aria-label={`Visit ${sponsor.name}`}
      class="block"
    >
      {inner}
    </a>
  ) : (
    inner
  );
}

export function SponsorGrid({
  sponsors,
  showTierHeaders = false,
}: {
  sponsors: SponsorView[];
  showTierHeaders?: boolean;
}) {
  if (sponsors.length === 0) return null;

  if (!showTierHeaders) {
    return (
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
        {sponsors.map((s) => (
          <SponsorCard sponsor={s} />
        ))}
      </div>
    );
  }

  return (
    <div class="space-y-12">
      {TIER_ORDER.map((tier) => {
        const inTier = sponsors.filter((s) => s.tier === tier);
        if (inTier.length === 0) return null;
        return (
          <div>
            <h3 class="font-display text-xl font-semibold text-neutral-900 mb-6 text-center">
              {TIER_HEADINGS[tier]}
            </h3>
            <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
              {inTier.map((s) => (
                <SponsorCard sponsor={s} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
