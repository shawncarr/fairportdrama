export const SITE_NAME = 'Fairport Drama Club';
export const SITE_DESCRIPTION =
  'Fairport High School Drama Club - Showcasing student talent through theatrical productions';
export const DEFAULT_OG_IMAGE = '/images/og-default.jpg';

export const organizationSchema = (siteUrl: string) => ({
  '@context': 'https://schema.org',
  '@type': 'PerformingGroup',
  name: SITE_NAME,
  alternateName: 'Fairport High School Drama Club',
  url: siteUrl,
  logo: new URL('/images/logo.png', siteUrl).toString(),
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
