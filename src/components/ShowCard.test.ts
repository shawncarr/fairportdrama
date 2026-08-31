import { describe, expect, it } from 'vitest';
import { SHOW_COMPANY } from '~/db/schema/content';
import { ShowCard, type ShowCardView } from './ShowCard';

const render = async (show: ShowCardView, dates?: boolean) =>
  String(
    await (ShowCard({ show, dates }) as unknown as {
      toString(): Promise<string> | string;
    }).toString(),
  );

const base: ShowCardView = {
  id: 'the-lightning-thief-2026',
  title: 'The Lightning Thief',
  season: 'Spring 2026',
  company: null,
  posterUrl: null,
  firstPerformance: '2026-03-05',
  lastPerformance: '2026-03-07',
};

describe('ShowCard', () => {
  it('shows the company label and never the stored slug', async () => {
    const html = await render({ ...base, company: SHOW_COMPANY.Jv });

    expect(html).toContain('JV');
    // The slugs are provisional. One reaching a page is the failure this
    // whole label indirection exists to prevent.
    expect(html).not.toContain('>jv<');
  });

  it('renders no badge for a show the whole club stages', async () => {
    // The badge is the card's only span, so this asserts the element is
    // absent rather than that one Tailwind class is - a badge restyle
    // should not quietly turn this into a test of nothing.
    expect(await render(base)).not.toContain('<span');
  });

  it('names the season and keeps the title an h3 under the section h2', async () => {
    const html = await render(base);

    expect(html).toContain('Spring 2026');
    expect(html).toContain('<h3');
  });

  it('renders the poster when there is one', async () => {
    const html = await render({ ...base, posterUrl: '/i/poster/card' });

    expect(html).toContain('<img');
    expect(html).toContain('src="/i/poster/card"');
  });

  it('gives a dateless show a line saying so', async () => {
    const html = await render({ ...base, firstPerformance: null, lastPerformance: null });

    expect(html).toContain('Dates to be announced');
  });

  it('omits the date line for the archive', async () => {
    expect(await render(base, false)).not.toContain('March 5-7, 2026');
  });

  it('links to the show', async () => {
    expect(await render(base)).toContain('href="/shows/the-lightning-thief-2026"');
  });
});
