import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import {
  memberOffices,
  memberRoles,
  members,
  news,
  showCast,
  showCrew,
  showGalleryImages,
  showPerformances,
  shows,
  sponsors,
  spiritWear,
  MEMBER_VISIBILITY,
  SHOW_COMPANY,
} from '~/db/schema/content';
import { APP_ROLE } from '~/db/schema/governance';
import { showDateLine } from '~/lib/dates';
import { get, resetTables, signIn } from '~/test/session';

/**
 * Every public page, in both its populated and its empty state.
 *
 * These are the pages visitors actually see, and they were the least covered
 * in the project: the admin tests exercise writes, and nothing rendered the
 * front of the site. A template that dropped a section on an inverted flag, or
 * threw on a null column, would have surfaced first to a visitor.
 *
 * The privacy assertions matter most. Whether a hidden member's surname
 * reaches a page is decided in the query layer, but it is only observable
 * here, in the HTML that actually ships.
 */

const db = () => getDb(env.DB);

const YESTERDAY = '2020-01-02';
const FAR_FUTURE = '2099-05-01';

/** A bare ISO date `d` days from now, for shows seeded relative to today. */
const iso = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

const body = async (path: string) => {
  const res = await get(path);
  expect(res.status, `${path} did not render`).toBe(200);
  return res.text();
};

/** A member who opted in, and one who did not. */
async function seedMembers() {
  await db().insert(members).values([
    {
      id: 'daniel-doser',
      name: 'Daniel Doser',
      grade: 'Senior',
      bio: 'Playing Percy this spring.',
      photoImageId: 'img-daniel',
      visibility: MEMBER_VISIBILITY.Full,
      isActive: true,
    },
    {
      id: 'hidden-harriet',
      name: 'Harriet Hidden',
      grade: 'Junior',
      bio: 'This must never appear.',
      photoImageId: 'img-harriet',
      visibility: MEMBER_VISIBILITY.Limited,
      isActive: true,
    },
  ]);

  // Officer status is derived from an open term, so the fixture records one.
  await db().insert(memberOffices).values({
    id: 'office-daniel',
    memberId: 'daniel-doser',
    title: 'President',
    startYear: 2026,
    endYear: null,
  });

  await db().insert(memberRoles).values([
    { memberId: 'daniel-doser', role: 'actor' },
    // Not in the display-name map, so the title-casing fallback renders.
    { memberId: 'daniel-doser', role: 'spot_operator' },
  ]);
}

async function seedShow(opts: { closed: boolean; featured: boolean }) {
  await db().insert(shows).values({
    id: 'lightning-thief',
    title: 'The Lightning Thief',
    season: 'Spring 2026',
    year: 2026,
    synopsis: 'A demigod quest across America.',
    ticketUrl: 'https://tickets.example.com',
    posterImageId: 'img-poster',
    heroImageId: 'img-hero',
    isAnnounced: opts.featured,
    isHighlighted: true,
  });

  await db().insert(showPerformances).values({
    id: 'perf-1',
    showId: 'lightning-thief',
    date: opts.closed ? YESTERDAY : FAR_FUTURE,
    time: '7:30 PM',
  });

  await db().insert(showCast).values([
    {
      id: 'cast-1',
      showId: 'lightning-thief',
      memberId: 'daniel-doser',
      role: 'Percy Jackson',
      additionalRoles: ['Understudy'],
      tier: 'lead',
      sortOrder: 0,
    },
    { id: 'cast-2', showId: 'lightning-thief', memberId: 'hidden-harriet', role: 'Annabeth', tier: 'lead', sortOrder: 1 },
    { id: 'cast-3', showId: 'lightning-thief', memberId: null, role: 'Ensemble', tier: 'ensemble', sortOrder: 2 },
  ]);

  await db().insert(showCrew).values({
    id: 'crew-1',
    showId: 'lightning-thief',
    memberId: 'hidden-harriet',
    role: 'Stage Manager',
    sortOrder: 0,
  });

  await db().insert(showGalleryImages).values({
    id: 'gal-1',
    showId: 'lightning-thief',
    imageId: 'img-gallery',
    sortOrder: 0,
  });

  await db().insert(sponsors).values([
    // Tied to this production, so it belongs on the show page.
    {
      id: 'spon-show',
      name: 'Show Sponsor Co',
      tier: 'gold',
      showId: 'lightning-thief',
      logoImageId: 'img-logo',
      isActive: true,
    },
    // Supports the club generally, so it belongs on the home page instead.
    { id: 'spon-club', name: 'Club Sponsor Co', tier: 'silver', showId: null, isActive: true },
  ]);
}

beforeEach(async () => {
  await resetTables([
    'show_gallery_images',
    'show_cast',
    'show_crew',
    'show_performances',
    'shows',
    'news',
    'sponsors',
    'spirit_wear',
    'member_offices',
    'member_roles',
    'members',
  ]);
});

describe('the members directory', () => {
  beforeEach(seedMembers);

  it('separates officers from everyone else', async () => {
    const html = await body('/members');
    expect(html).toContain('Club Officers');
    expect(html).toContain('President');
  });

  it('withholds the surname, photo, and link of a hidden member', async () => {
    const html = await body('/members');

    expect(html).toContain('Daniel Doser');
    expect(html).toContain('Harriet H.');
    // The three things `limited` exists to suppress.
    expect(html).not.toContain('Harriet Hidden');
    expect(html).not.toContain('img-harriet');
    expect(html).not.toContain('/members/hidden-harriet');
    expect(html).not.toContain('This must never appear');
  });

  it('serves a profile for a member who opted in', async () => {
    const html = await body('/members/daniel-doser');

    expect(html).toContain('Daniel Doser');
    expect(html).toContain('Playing Percy this spring.');
    expect(html).toContain('img-daniel');
    expect(html).toContain('Actor');
    // Unmapped role falls back to title case rather than rendering the raw key.
    expect(html).toContain('Spot Operator');
  });

  it('404s the profile of a hidden member, since the URL is the name', async () => {
    expect((await get('/members/hidden-harriet')).status).toBe(404);
    expect((await get('/members/nobody-at-all')).status).toBe(404);
  });

  it('lists a member with no photo without breaking the card', async () => {
    await db().insert(members).values({
      id: 'plain-pat',
      name: 'Pat Plain',
      grade: 'Sophomore',
      visibility: MEMBER_VISIBILITY.Full,
      isActive: true,
    });

    const html = await body('/members');
    expect(html).toContain('Pat Plain');
  });

  it('renders an empty directory rather than failing', async () => {
    await env.DB.exec('DELETE FROM member_roles');
    await env.DB.exec('DELETE FROM members');
    expect(await body('/members')).toContain('Our Members');
  });
});

describe('a show that is still running', () => {
  beforeEach(async () => {
    await seedMembers();
    await seedShow({ closed: false, featured: true });
  });

  it('offers tickets and lists the performance dates', async () => {
    const html = await body('/shows/lightning-thief');

    expect(html).toContain('The Lightning Thief');
    expect(html).toContain('A demigod quest');
    expect(html).toContain('https://tickets.example.com');
    expect(html).toContain('img-hero');
    expect(html).toContain('img-poster');
  });

  it('shows cast, crew, additional roles, TBA, and the gallery', async () => {
    const html = await body('/shows/lightning-thief');

    expect(html).toContain('Percy Jackson');
    expect(html).toContain('Understudy');
    expect(html).toContain('Ensemble');
    expect(html).toContain('TBA');
    expect(html).toContain('Stage Manager');
    expect(html).toContain('img-gallery');
  });

  it('credits the sponsors of this production, not the club-wide ones', async () => {
    const showPage = await body('/shows/lightning-thief');
    expect(showPage).toContain('Show Sponsor Co');
    expect(showPage).not.toContain('Club Sponsor Co');

    const homePage = await body('/');
    expect(homePage).toContain('Club Sponsor Co');
    expect(homePage).not.toContain('Show Sponsor Co');
  });

  it('reduces a hidden member in the cast and crew without linking them', async () => {
    const html = await body('/shows/lightning-thief');

    expect(html).toContain('Harriet H.');
    expect(html).not.toContain('Harriet Hidden');
    expect(html).not.toContain('/members/hidden-harriet');
  });

  it('is what /shows/current resolves to', async () => {
    const res = await get('/shows/current');
    expect([200, 302]).toContain(res.status);
    if (res.status === 302) {
      expect(res.headers.get('location')).toContain('lightning-thief');
    }
  });

  it('puts the show on the home page with a countdown', async () => {
    const html = await body('/');
    expect(html).toContain('The Lightning Thief');
    expect(html).toContain('countdown');
    expect(html).toContain('Opening Night In');
  });
});

describe('a show whose run has ended', () => {
  beforeEach(async () => {
    await seedMembers();
    await seedShow({ closed: true, featured: true });
  });

  it('says the run is over instead of selling tickets', async () => {
    const html = await body('/shows/lightning-thief');
    expect(html.toLowerCase()).toContain('ended');
    expect(html).not.toContain('https://tickets.example.com');
  });

  it('says so on the home page too, and drops the countdown', async () => {
    const html = await body('/');
    expect(html.toLowerCase()).toContain('ended');
    expect(html).not.toContain('Opening Night In');
  });

  it('appears in the past shows archive', async () => {
    const html = await body('/shows');
    expect(html).toContain('The Lightning Thief');
  });
});

describe('when there is no featured show', () => {
  it('the home page still renders', async () => {
    const html = await body('/');
    expect(html).toContain('Fairport');
  });

  it('the archive says so rather than showing an empty grid', async () => {
    expect(await body('/shows')).toContain('Past Productions');
  });

  it('an unknown show 404s', async () => {
    expect((await get('/shows/no-such-show')).status).toBe(404);
  });
});

describe('the shows index', () => {
  const seed = async (
    id: string,
    opts: { announced: boolean; date: string },
  ) => {
    await db().insert(shows).values({
      id,
      title: id,
      season: 'Spring 2027',
      year: 2027,
      synopsis: 'A show.',
      isAnnounced: opts.announced,
    });
    await db()
      .insert(showPerformances)
      .values({ id: `${id}-p`, showId: id, date: opts.date, time: '7:30 PM' });
  };

  beforeEach(async () => {
    await seed('upcoming-show', { announced: true, date: iso(10) });
    await seed('staged-show', { announced: false, date: iso(20) });
    await seed('archived-show', { announced: false, date: iso(-30) });
  });

  it('lists upcoming shows above past ones', async () => {
    const html = await body('/shows');

    // Match the heading's text node, not the bare word: the page's meta
    // description is "Upcoming and past productions..." and lives in <head>,
    // so `toContain('Upcoming')` and an indexOf comparison against it both
    // pass with the entire Upcoming section deleted.
    expect(html).toContain('>Upcoming<');
    // Assert presence first: indexOf returns -1 when absent, and -1 is less
    // than any real index, so the comparison alone passes for a show that
    // never rendered.
    expect(html).toContain('upcoming-show');
    expect(html).toContain('archived-show');
    expect(html.indexOf('upcoming-show')).toBeLessThan(html.indexOf('archived-show'));
  });

  it('opens the heading order at h1', async () => {
    // The sections are h2 and ShowCard's title is h3, so without this the
    // document outline starts at 2.
    expect(await body('/shows')).toContain('<h1');
  });

  it('shows the company label on the show page hero, never the slug', async () => {
    await db()
      .update(shows)
      .set({ company: SHOW_COMPANY.Jv })
      .where(eq(shows.id, 'upcoming-show'));

    // The hero has its own badge markup, separate from ShowCard's.
    const html = await body('/shows/upcoming-show');
    expect(html).toContain('>JV<');
    expect(html).not.toContain('>jv<');
  });

  it('hides the Upcoming section when nothing is upcoming', async () => {
    await db().delete(shows).where(eq(shows.id, 'upcoming-show'));

    expect(await body('/shows')).not.toContain('>Upcoming<');
  });

  it('dates the upcoming cards and leaves the archive undated', async () => {
    const html = await body('/shows');

    expect(html).toContain(showDateLine(iso(10), iso(10)));
    expect(html).not.toContain(showDateLine(iso(-30), iso(-30)));
  });

  it('redirects the old past-shows URL to the index for good', async () => {
    const res = await get('/shows/past');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/shows');
  });

  it('sends /shows/current to the soonest upcoming show', async () => {
    // A second, later promoted show: with only one, picking the last
    // promoted row instead of the first gives the same answer.
    await seed('later-show', { announced: true, date: iso(40) });

    const res = await get('/shows/current');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/shows/upcoming-show');
  });

  it('404s a draft rather than serving it to anyone holding the URL', async () => {
    expect((await get('/shows/staged-show')).status).toBe(404);
  });

  it('still serves a past show that was never announced', async () => {
    expect((await get('/shows/archived-show')).status).toBe(200);
  });

  it('shows a draft to whoever can edit it, so it can be checked first', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    expect((await get('/shows/staged-show', cookie)).status).toBe(200);
  });

  it('offers tickets on every announced running show, not just one', async () => {
    await db()
      .update(shows)
      .set({ ticketUrl: 'https://tickets.example.com' })
      .where(eq(shows.id, 'upcoming-show'));
    await seed('second-show', { announced: true, date: iso(14) });
    await db()
      .update(shows)
      .set({ ticketUrl: 'https://tickets.example.com/2' })
      .where(eq(shows.id, 'second-show'));

    expect(await body('/shows/upcoming-show')).toContain('Get Tickets');
    expect(await body('/shows/second-show')).toContain('Get Tickets');
  });
});

describe('news', () => {
  it('says when there is nothing published', async () => {
    expect(await body('/news')).toContain('No news');
  });

  it('lists published posts and hides drafts', async () => {
    await db().insert(news).values([
      {
        id: 'auditions-open',
        title: 'Auditions Open',
        excerpt: 'Come and try out.',
        bodyMd: '## Details\n\nBring a song.',
        publishedAt: '2026-01-05',
        category: 'auditions',
        isDraft: false,
        featuredImageId: 'img-news',
      },
      {
        id: 'secret-draft',
        title: 'Secret Draft',
        excerpt: 'Not ready.',
        bodyMd: 'wip',
        publishedAt: '2026-01-06',
        category: 'general',
        isDraft: true,
      },
    ]);

    const html = await body('/news');
    expect(html).toContain('Auditions Open');
    expect(html).not.toContain('Secret Draft');
  });

  it('renders a post, with its markdown turned into HTML', async () => {
    await db().insert(news).values({
      id: 'auditions-open',
      title: 'Auditions Open',
      excerpt: 'Come and try out.',
      bodyMd: '## Details\n\nBring a song.',
      publishedAt: '2026-01-05',
      category: 'auditions',
      isDraft: false,
      featuredImageId: 'img-news',
    });

    const html = await body('/news/auditions-open');
    expect(html).toContain('<h2>Details</h2>');
    expect(html).toContain('Bring a song.');
    expect(html).toContain('img-news');
  });

  it('404s a draft and an unknown slug alike', async () => {
    await db().insert(news).values({
      id: 'secret-draft',
      title: 'Secret Draft',
      excerpt: 'x',
      bodyMd: 'x',
      publishedAt: '2026-01-06',
      category: 'general',
      isDraft: true,
    });

    expect((await get('/news/secret-draft')).status).toBe(404);
    expect((await get('/news/nothing-here')).status).toBe(404);
  });
});

describe('spirit wear', () => {
  it('says when nothing is for sale', async () => {
    expect(await body('/spiritwear')).toContain('No items');
  });

  it('shows price, sizes, colors, and the featured badge', async () => {
    await db().insert(spiritWear).values([
      {
        id: 'sw-1',
        name: 'Drama Hoodie',
        description: 'Heavyweight.',
        priceCents: 3500,
        imageId: 'img-hoodie',
        sizes: ['S', 'M', 'L'],
        colors: ['Navy'],
        isAvailable: true,
        isFeatured: true,
      },
      // No image, no sizes, no colors: the other side of every branch.
      {
        id: 'sw-2',
        name: 'Sticker',
        description: 'Small.',
        priceCents: 200,
        sizes: [],
        colors: [],
        isAvailable: true,
        isFeatured: false,
      },
      { id: 'sw-3', name: 'Sold Out Tee', description: 'Gone.', priceCents: 100, isAvailable: false },
    ]);

    const html = await body('/spiritwear');
    expect(html).toContain('Drama Hoodie');
    expect(html).toContain('$35.00');
    expect(html).toContain('Sizes: S, M, L');
    expect(html).toContain('Colors: Navy');
    expect(html).toContain('Featured');
    expect(html).toContain('Sticker');
    expect(html).toContain('$2.00');
    // Unavailable items are not offered.
    expect(html).not.toContain('Sold Out Tee');
  });
});

describe('sponsors', () => {
  it('shows the tier ladder even with no sponsors yet', async () => {
    const html = await body('/about/sponsors');
    expect(html).toContain('Sponsorship Levels');
    expect(html).toContain('Platinum');
    expect(html).not.toContain('Thank You to Our Supporters');
  });

  it('groups sponsors under tier headings, with logos and links', async () => {
    await db().insert(sponsors).values([
      { id: 's1', name: 'Gold Co', tier: 'gold', logoImageId: 'img-gold', website: 'https://gold.example.com', isActive: true },
      // No logo, so the name renders as text instead.
      { id: 's2', name: 'Bronze Co', tier: 'bronze', isActive: true },
      { id: 's3', name: 'Hidden Co', tier: 'gold', isActive: false },
    ]);

    const html = await body('/about/sponsors');
    expect(html).toContain('Thank You to Our Supporters');
    expect(html).toContain('Gold Sponsors');
    expect(html).toContain('img-gold');
    expect(html).toContain('https://gold.example.com');
    expect(html).toContain('Bronze Co');
    expect(html).not.toContain('Hidden Co');
  });
});

describe('the remaining public pages', () => {
  it('render', async () => {
    expect(await body('/about/boosters')).toContain('Boosters');
    expect(await body('/about/contact')).toContain('Contact');
    expect(await body('/disclaimer')).toContain('Student Privacy');
  });

  it('the footer carries the newsletter form and the disclaimer link', async () => {
    const html = await body('/');
    expect(html).toContain('/api/newsletter/subscribe');
    expect(html).toContain('/disclaimer');
  });

  it('404 returns a real 404, not a 200 with a message', async () => {
    const res = await get('/no/such/page');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Page Not Found');
  });
});

describe('the sitemap', () => {
  it('lists opted-in members and published news, and nothing hidden', async () => {
    await seedMembers();
    await seedShow({ closed: false, featured: true });
    await db().insert(news).values([
      { id: 'live-post', title: 'Live', excerpt: 'x', bodyMd: 'x', publishedAt: '2026-01-05', category: 'general', isDraft: false },
      { id: 'draft-post', title: 'Draft', excerpt: 'x', bodyMd: 'x', publishedAt: '2026-01-05', category: 'general', isDraft: true },
    ]);

    const xml = await (await get('/sitemap.xml')).text();
    expect(xml).toContain('/members/daniel-doser');
    expect(xml).toContain('/news/live-post');
    expect(xml).toContain('/shows/lightning-thief');
    // A hidden member's slug is their full name, so it must not be published
    // even though the page itself 404s.
    expect(xml).not.toContain('hidden-harriet');
    expect(xml).not.toContain('draft-post');
  });

  it('robots points at the sitemap and keeps crawlers out of the admin', async () => {
    const txt = await (await get('/robots.txt')).text();
    expect(txt).toContain('Disallow: /admin');
    expect(txt).toContain('sitemap.xml');
  });
});

describe('the legal pages Google requires', () => {
  it('both render and are reachable from every page footer', async () => {
    expect(await body('/privacy')).toContain('Privacy Policy');
    expect(await body('/terms')).toContain('Terms of Use');

    const home = await body('/');
    expect(home).toContain('href="/privacy"');
    expect(home).toContain('href="/terms"');
  });

  it('are listed in the sitemap, so Google can reach them', async () => {
    const xml = await (await get('/sitemap.xml')).text();
    expect(xml).toContain('/privacy');
    expect(xml).toContain('/terms');
  });

  it('name the third parties that actually receive data', async () => {
    const html = await body('/privacy');
    expect(html).toContain('Cloudflare');
    expect(html).toContain('Google');
  });

  it('states plainly that change records are kept indefinitely', async () => {
    // No purge has been built. Implying a retention schedule we do not have
    // would be the easiest thing here to get quietly wrong.
    expect(await body('/privacy')).toContain('kept indefinitely');
  });

  it('says the newsletter is not sent from this site', async () => {
    expect(await body('/privacy')).toContain('do not currently send');
  });

  it('tells people how to have information removed', async () => {
    const html = await body('/privacy');
    expect(html).toContain('/about/contact');
    expect(html).toContain('remove');
  });

  it('the terms say nothing is sold here', async () => {
    expect(await body('/terms')).toContain('Nothing is sold here');
  });
});

describe('social sharing tags', () => {
  it('omits og:image rather than pointing at a file that does not exist', async () => {
    const html = await body('/about/boosters');

    // The Astro site defaulted to /images/og-default.jpg, which was eleven
    // bytes of the text "placeholder". A broken thumbnail is worse than none.
    expect(html).not.toContain('og-default');
    expect(html).not.toContain('property="og:image"');
    // A card with no image should say so, or the network reserves space for one.
    expect(html).toContain('content="summary"');
  });

  it('still carries the title, description, and canonical URL', async () => {
    const html = await body('/about/boosters');
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:description"');
    expect(html).toContain('rel="canonical"');
  });

  it('uses a show’s own artwork when it has some', async () => {
    await seedMembers();
    await seedShow({ closed: false, featured: true });

    const html = await body('/shows/lightning-thief');
    expect(html).toContain('property="og:image"');
    expect(html).toContain('content="summary_large_image"');
  });
});
