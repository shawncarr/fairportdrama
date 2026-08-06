import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import {
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
} from '~/db/schema/content';
import { get, resetTables } from '~/test/session';

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
      isOfficer: true,
      officerTitle: 'President',
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
    isCurrent: opts.featured,
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

  it('appears in the past shows archive even while still flagged current', async () => {
    const html = await body('/shows/past');
    expect(html).toContain('The Lightning Thief');
  });
});

describe('when there is no featured show', () => {
  it('the home page still renders', async () => {
    const html = await body('/');
    expect(html).toContain('Fairport');
  });

  it('the archive says so rather than showing an empty grid', async () => {
    expect(await body('/shows/past')).toContain('Past Productions');
  });

  it('an unknown show 404s', async () => {
    expect((await get('/shows/no-such-show')).status).toBe(404);
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
