import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import {
  members,
  news,
  showCast,
  showCrew,
  showGalleryImages,
  SHOW_COMPANY,
  showPerformances,
  shows,
  sponsors,
  spiritWear,
  MEMBER_VISIBILITY,
} from '~/db/schema/content';
import {
  auditEvents,
  invites,
  pendingEdits,
  APP_ROLE,
  PENDING_EDIT_STATUS,
} from '~/db/schema/governance';
import { newsletterSubscribers } from '~/db/schema/newsletter';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { generateId } from '~/lib/id';
import { get, resetTables, signIn } from '~/test/session';

/**
 * Renders every admin page against realistic content.
 *
 * The rest of the admin tests drive writes and assert database state, which
 * leaves the pages themselves - the largest part of the file - unexercised. A
 * template that throws on a null column, or silently drops a section because a
 * flag is inverted, would pass every one of those tests and still be broken in
 * front of whoever opened it.
 *
 * Each case asserts on content that could only appear if the data path ran,
 * rather than on a 200.
 */

const db = () => getDb(env.DB);

/** Content covering the branches templates take: set and unset, on and off. */
async function seedFixture() {
  await db().insert(members).values([
    {
      id: 'daniel-doser',
      name: 'Daniel Doser',
      grade: 'Senior',
      graduationYear: 2026,
      bio: 'Plays Percy.',
      photoImageId: 'img-daniel',
      instagram: 'danield',
      visibility: MEMBER_VISIBILITY.Full,
      isActive: true,
    },
    // Deliberately sparse: no photo, no bio, no year, inactive, hidden.
    { id: 'quiet-student', name: 'Quiet Student', grade: 'Freshman', isActive: false },
  ]);

  await db().insert(shows).values({
    id: 'lightning-thief',
    title: 'The Lightning Thief',
    season: 'Spring 2026',
    year: 2026,
    synopsis: 'A demigod quest.',
    ticketUrl: 'https://tickets.example.com',
    posterImageId: 'img-poster',
    isAnnounced: true,
  });

  await db().insert(showPerformances).values({
    id: 'perf-1',
    showId: 'lightning-thief',
    date: '2026-03-07',
    time: '7:30 PM',
  });

  await db().insert(showCast).values([
    { id: 'cast-1', showId: 'lightning-thief', memberId: 'daniel-doser', role: 'Percy', tier: 'lead', sortOrder: 0 },
    // Uncast role, so the TBA path renders.
    { id: 'cast-2', showId: 'lightning-thief', memberId: null, role: 'Ensemble', tier: 'ensemble', sortOrder: 1 },
  ]);

  await db().insert(showCrew).values({
    id: 'crew-1',
    showId: 'lightning-thief',
    memberId: 'daniel-doser',
    role: 'Stage Manager',
    sortOrder: 0,
  });

  await db().insert(showGalleryImages).values({
    id: 'gal-1',
    showId: 'lightning-thief',
    imageId: 'img-gallery',
    sortOrder: 0,
  });

  await db().insert(news).values([
    {
      id: 'auditions-open',
      title: 'Auditions Open',
      excerpt: 'Come try out.',
      bodyMd: '# Auditions',
      publishedAt: '2026-01-05',
      category: 'auditions',
      isDraft: false,
    },
    {
      id: 'draft-post',
      title: 'Draft Post',
      excerpt: 'Not ready.',
      bodyMd: 'wip',
      publishedAt: '2026-02-01',
      category: 'general',
      isDraft: true,
    },
  ]);

  await db().insert(sponsors).values({
    id: 'spon-1',
    name: 'Fairport Hardware',
    tier: 'gold',
    website: 'https://example.com',
    isActive: true,
  });

  await db().insert(spiritWear).values({
    id: 'sw-1',
    name: 'Hoodie',
    description: 'Warm.',
    priceCents: 3500,
    sizes: ['S', 'M'],
    colors: ['Navy'],
    isAvailable: true,
    isFeatured: true,
  });

  await db().insert(pendingEdits).values({
    id: 'pe-1',
    targetKind: AUDIT_ENTITY_KIND.Member,
    targetId: 'daniel-doser',
    proposed: { bio: 'A new bio.', photoImageId: 'img-proposed' },
    submittedByUserId: 'u_someone',
    submittedAt: '2026-02-10T00:00:00.000Z',
    status: PENDING_EDIT_STATUS.Pending,
  });

  await db().insert(auditEvents).values({
    id: generateId(),
    actorKind: 'user',
    actorUserId: 'u_someone',
    actorLabel: 'Someone Else',
    action: AUDIT_ACTION.MemberUpdated,
    targetKind: AUDIT_ENTITY_KIND.Member,
    targetId: 'daniel-doser',
    diff: { bio: { before: 'old', after: 'new' } },
    ip: '203.0.113.42',
    relatedEntities: [],
    createdAt: new Date().toISOString(),
  });

  await db().insert(newsletterSubscribers).values({
    email: 'subscriber@example.com',
    name: 'Subscriber',
    subscribedAt: '2026-01-01',
    confirmationToken: 'tok-1',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  });
}

const body = async (path: string, cookie: string) => {
  const res = await get(path, cookie);
  expect(res.status, `${path} did not render`).toBe(200);
  return res.text();
};

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
    'members',
  ]);
  await env.DB.exec('DELETE FROM newsletter_subscribers');
  await seedFixture();
});

describe('pages an admin sees', () => {
  it('overview counts the approval queue and public members', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await body('/admin', cookie);

    expect(html).toContain('Edits awaiting review');
    expect(html).toContain('Members showing full profiles');
    expect(html).toContain('not linked to a member profile');
  });

  it('members list shows visibility, grade, and what each has', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await body('/admin/members', cookie);

    expect(html).toContain('Daniel Doser');
    expect(html).toContain('photo release is on file');
    expect(html).toContain('photo, bio');
    expect(html).toContain('1 of 2');
  });

  it('member editor renders every field, populated and empty', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const full = await body('/admin/members/daniel-doser', cookie);

    expect(full).toContain('value="Daniel Doser"');
    expect(full).toContain('value="2026"');
    expect(full).toContain('Plays Percy.');
    expect(full).toContain('value="danield"');
    // The checkbox became a term with a start and end year.
    expect(full).toContain('Club offices');
    expect(full).toContain('name="startYear"');
    expect(full).not.toContain('name="isOfficer"');
    expect(full).toContain('Remove the photo');
    // A pending edit must warn that approving later overwrites this.
    expect(full).toContain('waiting in');

    const sparse = await body('/admin/members/quiet-student', cookie);
    expect(sparse).toContain('Not on the roster');
    expect(sparse).toContain('Quiet S.');
    expect(sparse).not.toContain('Remove the photo');
  });

  it('approvals renders the proposed photo as an image, not an id', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await body('/admin/approvals', cookie);

    expect(html).toContain('Your name is recorded');
    expect(html).toContain('A new bio.');
    // Approving a photo nobody can see would make the acknowledgement hollow.
    expect(html).toContain('img-proposed');
    expect(html).toContain('accept responsibility');
  });

  it('activity log shows the actor, the changed fields, and the IP', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await body('/admin/audit', cookie);

    expect(html).toContain('Someone Else');
    expect(html).toContain('bio');
    expect(html).toContain('203.0.113.42');
  });

  it('accounts lists invites and existing accounts with their role', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await db().insert(invites).values({
      id: generateId(),
      email: 'pending@example.com',
      role: APP_ROLE.Member,
      memberId: 'daniel-doser',
      token: generateId(),
      expiresAt: new Date(Date.now() + 864e5).toISOString(),
      createdByUserId: 'seed',
      createdAt: new Date().toISOString(),
    });

    const html = await body('/admin/accounts', cookie);
    expect(html).toContain('pending@example.com');
    expect(html).toContain('board@example.com');
    expect(html).toContain('Existing accounts');
    expect(html).toContain('Daniel Doser');
  });

  it('newsletter lists subscribers and states that nothing is sent from here', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await body('/admin/newsletter', cookie);

    expect(html).toContain('subscriber@example.com');
    expect(html).toContain('does not send newsletters');
  });

  it('news list distinguishes draft from published', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await body('/admin/news', cookie);

    expect(html).toContain('Auditions Open');
    expect(html).toContain('Draft Post');
    expect(html).toContain('draft');
    expect(html).toContain('published');
  });

  it('news editor loads an existing post into the form', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await body('/admin/news/auditions-open', cookie);

    expect(html).toContain('value="Auditions Open"');
    expect(html).toContain('Come try out.');
    expect(html).toContain('# Auditions');
    expect(html).toContain('value="2026-01-05"');
  });

  it('news editor renders blank for a new post', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await body('/admin/news/new', cookie);
    expect(html).toContain('name="title"');
    expect(html).not.toContain('Auditions Open');
  });

  it('marks each of the three states, so a draft reads as having no page', async () => {
    await db().insert(shows).values([
      {
        id: 'still-to-run',
        title: 'Still To Run',
        season: 'Spring 2027',
        year: 2027,
        synopsis: 'Announced, still to run.',
        isAnnounced: true,
      },
      {
        id: 'not-announced',
        title: 'Not Announced',
        season: 'Fall 2027',
        year: 2027,
        synopsis: 'Not announced.',
        isAnnounced: false,
      },
    ]);
    await db().insert(showPerformances).values({
      id: 'still-to-run-p',
      showId: 'still-to-run',
      date: '2099-01-01',
      time: '7:30 PM',
    });

    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await body('/admin/shows', cookie);

    // Each badge is read out of its own <tr>. Asserting the three labels
    // appear somewhere in a three-row table proves nothing: swapping the
    // announced and unannounced branches leaves all three strings present
    // and every row mislabelled.
    const row = (title: string) => {
      const at = html.indexOf(title);
      expect(at, `${title} is not in the list`).toBeGreaterThan(-1);
      return html.slice(at, html.indexOf('</tr>', at));
    };

    expect(row('Still To Run')).toContain('>Upcoming<');
    expect(row('Not Announced')).toContain('>Draft<');
    expect(row('The Lightning Thief')).toContain('>Closed<');

    // The column headers the status and company cells sit under.
    expect(html).toContain('>Status<');
    expect(html).toContain('>Company<');
  });

  it('names the company in the list, and dashes a show without one', async () => {
    await db()
      .update(shows)
      .set({ company: SHOW_COMPANY.Jv })
      .where(eq(shows.id, 'lightning-thief'));
    await db().insert(shows).values({
      id: 'whole-club',
      title: 'Whole Club',
      season: 'Fall 2027',
      year: 2027,
      synopsis: 'No company.',
      isAnnounced: false,
    });

    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await body('/admin/shows', cookie);

    const row = (title: string) => {
      const at = html.indexOf(title);
      return html.slice(at, html.indexOf('</tr>', at));
    };

    // The label, never the provisional slug - the same property the card,
    // the hero and the show page are each tested for.
    expect(row('The Lightning Thief')).toContain('JV');
    expect(row('The Lightning Thief')).not.toContain('>jv<');
    expect(row('Whole Club')).toContain('\u2014');
  });

  it('wires the announce button to this show, and to the right field', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await body('/admin/shows/lightning-thief', cookie);

    // Nothing else connects the rendered panel to the route: the service
    // tests post hand-built form data. Renaming the hidden field back to
    // `featured` turns the Announce button into an un-announce button, and
    // every test still passes.
    expect(html).toContain('action="/admin/shows/lightning-thief/announce"');
    expect(html).toContain('name="announced"');
    expect(html).not.toContain('name="featured"');
  });

  it('wires the un-announced show\u2019s button the same way', async () => {
    await db().insert(shows).values({
      id: 'not-yet',
      title: 'Not Yet',
      season: 'Fall 2027',
      year: 2027,
      synopsis: 'Staged.',
      isAnnounced: false,
    });

    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await body('/admin/shows/not-yet', cookie);

    // The panel has two branches and the seeded show only ever renders one.
    // This is the branch whose field name, if it drifts back to `featured`,
    // makes the Announce button silently un-announce.
    expect(html).toContain('action="/admin/shows/not-yet/announce"');
    expect(html).toContain('name="announced"');
    expect(html).not.toContain('name="featured"');
  });

  it('preselects the company on the edit form', async () => {
    await db()
      .update(shows)
      .set({ company: SHOW_COMPANY.Jv })
      .where(eq(shows.id, 'lightning-thief'));

    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await body('/admin/shows/lightning-thief', cookie);

    expect(html).toContain('value="jv" selected');
  });

  it('show page renders details, dates, cast, crew, artwork, and gallery', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await body('/admin/shows/lightning-thief', cookie);

    expect(html).toContain('value="The Lightning Thief"');
    expect(html).toContain('A demigod quest.');
    expect(html).toContain('value="https://tickets.example.com"');
    expect(html).toContain('value="2026-03-07"');
    expect(html).toContain('value="7:30 PM"');
    expect(html).toContain('value="Percy"');
    expect(html).toContain('Stage Manager');
    expect(html).toContain('img-poster');
    expect(html).toContain('img-gallery');
    // Featured already, so it offers to stop rather than to start.
    expect(html).toContain('Stop announcing it');
    // Cast exists, so deletion must be refused with a reason.
    expect(html).toContain('can no longer be deleted');
  });

  it('show page for a new show offers featuring and deletion', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await db().insert(shows).values({
      id: 'empty-show',
      title: 'Empty Show',
      season: 'Fall 2026',
      year: 2026,
      synopsis: 'Nothing yet.',
    });

    const html = await body('/admin/shows/empty-show', cookie);
    expect(html).toContain('Announce on the home page');
    expect(html).toContain('Delete show');
  });

  it('new show form renders', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await body('/admin/shows/new', cookie);
    expect(html).toContain('name="season"');
    expect(html).toContain('not announced on the home page until you say so');
  });

  it('sponsors and spirit wear editors load existing rows', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const sponsorHtml = await body('/admin/sponsors', cookie);
    expect(sponsorHtml).toContain('value="Fairport Hardware"');
    expect(sponsorHtml).toContain('Add a sponsor');

    const swHtml = await body('/admin/spiritwear', cookie);
    expect(swHtml).toContain('value="Hoodie"');
    expect(swHtml).toContain('value="35.00"');
    expect(swHtml).toContain('value="S, M"');
  });
});

describe('pages a member sees', () => {
  it('profile shows their own record and warns about pending review', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    const html = await body('/admin/profile', cookie);

    expect(html).toContain('Plays Percy.');
    expect(html).toContain('value="danield"');
    // A queued photo must be shown as submitted, not as live.
    expect(html).toContain('not on the site until it is approved');
    expect(html).toContain('waiting for');
  });

  it('profile explains itself when the account has no member linked', async () => {
    const cookie = await signIn('board2@example.com', APP_ROLE.Member);
    const html = await body('/admin/profile', cookie);
    expect(html).toContain('not linked to a member record');
  });

  it('activity log shows their own changes without IP addresses', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    const html = await body('/admin/audit', cookie);

    expect(html).toContain('Changes you made');
    expect(html).not.toContain('203.0.113.42');
  });
});

describe('sign in and out', () => {
  it('renders the sign-in page with both routes in', async () => {
    const html = await body('/admin/sign-in', '');
    expect(html).toContain('Continue with Google');
    expect(html).toContain('Email me a sign-in link');
    expect(html).toContain('by invitation');
  });

  it('starts Google sign-in from a plain link, carrying the state cookie', async () => {
    // The button used to point straight at Better Auth's /sign-in/social,
    // which is POST-only - so it 404'd, and nothing caught it because no test
    // followed the link. This route does the call server-side and redirects.
    const res = await get('/admin/sign-in/google?next=%2Fadmin');

    expect(res.status).toBe(302);

    const target = new URL(res.headers.get('location')!);
    expect(target.host).toBe('accounts.google.com');
    // The value Google matches against its registered list; a mismatch here is
    // the difference between working and redirect_uri_mismatch.
    expect(target.searchParams.get('redirect_uri')).toContain(
      '/api/auth/callback/google',
    );
    expect(target.searchParams.get('scope')).toBe('email profile openid');
    expect(target.searchParams.get('client_id')).toBeTruthy();

    // Without the state cookie the callback fails a check that exists to
    // reject a forged one.
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.includes('better-auth.state'))).toBe(true);
  });

  it('the sign-in page links to that route, not to the POST-only endpoint', async () => {
    const html = await body('/admin/sign-in', '');
    expect(html).toContain('/admin/sign-in/google');
    expect(html).not.toContain('/api/auth/sign-in/social');
  });

  it('redirects an already signed-in visitor away from sign-in', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const res = await get('/admin/sign-in?next=/admin/members', cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/members');
  });
});
