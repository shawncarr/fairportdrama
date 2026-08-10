export const SITE_NAME = 'Fairport Drama Club';
export const SITE_DESCRIPTION =
  'Fairport High School Drama Club - Showcasing student talent through theatrical productions';
/**
 * Site-wide social sharing image, used by pages that have none of their own.
 *
 * Null because there is no such file. The Astro site pointed at
 * /images/og-default.jpg, which turned out to be eleven bytes of the text
 * "placeholder" - so every page without its own image advertised a broken
 * thumbnail to every social network that fetched it. No image at all is
 * better: the networks fall back to a text-only card rather than a broken one.
 *
 * To restore it, drop a real 1200x630 image at public/images/og-default.jpg
 * and set this to that path. Show and news pages are unaffected either way;
 * they supply their own.
 */
export const DEFAULT_OG_IMAGE: string | null = null;

export const organizationSchema = (siteUrl: string) => ({
  '@context': 'https://schema.org',
  '@type': 'PerformingGroup',
  name: SITE_NAME,
  alternateName: 'Fairport High School Drama Club',
  url: siteUrl,
  // No `logo`. It pointed at /images/logo.png, which does not exist and never
  // did - not in this project and not in the Astro site it was copied from, so
  // the structured data has always advertised a 404 to every crawler that read
  // it. Omitting the property is valid; a broken URL is worse than none.
  // Drop a real image at public/images/logo.png and restore this line.
  description:
    'High school drama club showcasing student talent through theatrical productions',
  address: {
    '@type': 'PostalAddress',
    streetAddress: '1 Dave Paddock Way',
    addressLocality: 'Fairport',
    addressRegion: 'NY',
    postalCode: '14450',
    addressCountry: 'US',
  },
  parentOrganization: {
    '@type': 'EducationalOrganization',
    name: 'Fairport High School',
  },
  sameAs: [
    'https://instagram.com/fairportdrama',
    'https://facebook.com/fairportdrama',
    'https://youtube.com/@fairportdrama',
  ],
});
