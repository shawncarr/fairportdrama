import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '~/db/queries';
import { members, MEMBER_VISIBILITY } from '~/db/schema/content';
import { APP_ROLE } from '~/db/schema/governance';
import { get, resetTables, signIn } from '~/test/session';

/**
 * The admin roster's filters.
 *
 * Filtering here exists to drive the bulk visibility change under the table -
 * "everyone with a photo and a bio who is still private" is the opt-in
 * workflow - so the markup has to carry enough per-row state to answer that
 * without a round trip.
 */

const db = () => getDb(env.DB);

const page = async (cookie: string) => {
  const res = await get('/admin/members', cookie);
  expect(res.status).toBe(200);
  return res.text();
};

/** The row markup for one member, so assertions can be made about it alone. */
const rowFor = (html: string, name: string) => {
  const rows = html.split('<tr');
  const match = rows.find((r) => r.includes(`>${name}<`));
  expect(match, `no row for ${name}`).toBeDefined();
  return match!;
};

beforeEach(async () => {
  await resetTables(['member_offices', 'member_roles', 'members']);
  await db().insert(members).values([
    {
      id: 'full-fran', name: 'Fran Full', grade: 'Senior',
      visibility: MEMBER_VISIBILITY.Full, isActive: true,
      photoImageId: 'img_1', bio: 'A bio.',
    },
    {
      id: 'bare-bart', name: 'Bart Bare', grade: 'Freshman',
      visibility: MEMBER_VISIBILITY.Limited, isActive: true,
    },
    {
      id: 'gone-gil', name: 'Gil Gone', grade: 'Alumni',
      visibility: MEMBER_VISIBILITY.Limited, isActive: false,
      photoImageId: 'img_2',
    },
  ]);
});

describe('the filter controls', () => {
  it('offers a search box and every dimension the table shows', async () => {
    const html = await page(await signIn('board@example.com', APP_ROLE.Admin));

    expect(html).toContain('id="roster-search"');
    expect(html).toContain('id="roster-grade"');
    expect(html).toContain('id="roster-visibility"');
    expect(html).toContain('id="roster-status"');
    expect(html).toContain('id="roster-has"');
  });

  it('lists only the grades somebody is actually in', async () => {
    const html = await page(await signIn('board@example.com', APP_ROLE.Admin));
    const options = [...html.matchAll(/<option value="(\w+)">/g)].map((m) => m[1]);

    expect(options).toContain('Senior');
    expect(options).toContain('Freshman');
    expect(options).toContain('Alumni');
    // An option that can only ever select nothing is noise.
    expect(options).not.toContain('Sophomore');
  });
});

describe('what each row carries', () => {
  it('tags the name, grade, visibility and status it can be filtered on', async () => {
    const html = await page(await signIn('board@example.com', APP_ROLE.Admin));
    const row = rowFor(html, 'Fran Full');

    expect(row).toContain('data-name="fran full"');
    expect(row).toContain('data-grade="Senior"');
    expect(row).toContain(`data-visibility="${MEMBER_VISIBILITY.Full}"`);
    expect(row).toContain('data-status="active"');
  });

  it('marks an inactive member as such', async () => {
    const html = await page(await signIn('board@example.com', APP_ROLE.Admin));
    expect(rowFor(html, 'Gil Gone')).toContain('data-status="inactive"');
  });

  it('records what is on the profile, which is what the opt-in is judged on', async () => {
    const html = await page(await signIn('board@example.com', APP_ROLE.Admin));

    expect(rowFor(html, 'Fran Full')).toContain('data-has="photo bio"');
    expect(rowFor(html, 'Gil Gone')).toContain('data-has="photo"');
    // Empty, not absent: "has neither" has to be selectable.
    expect(rowFor(html, 'Bart Bare')).toContain('data-has=""');
  });
});

describe('selection', () => {
  it('offers a select-all that the script scopes to the visible rows', async () => {
    const html = await page(await signIn('board@example.com', APP_ROLE.Admin));

    expect(html).toContain('id="roster-select-all"');
    expect(html).toContain('Select all shown members');
  });

  it('ships the filter script with the table', async () => {
    const html = await page(await signIn('board@example.com', APP_ROLE.Admin));

    // What the script does - including clearing the checkbox of any row it
    // hides, so a filtered-out member can never be in the submit - is
    // exercised for real in RosterFilter.test.ts. This only pins that the
    // route serves it alongside the rows it operates on.
    expect(html).toContain('roster-select-all');
    expect(html).toContain('<script>');
  });

  it('reports how many are shown and how many are selected', async () => {
    const html = await page(await signIn('board@example.com', APP_ROLE.Admin));

    expect(html).toContain('data-shown');
    expect(html).toContain('data-selected');
    expect(html).toContain('Showing');
  });

  it('still renders every member, so the table works without JavaScript', async () => {
    const html = await page(await signIn('board@example.com', APP_ROLE.Admin));

    for (const name of ['Fran Full', 'Bart Bare', 'Gil Gone']) {
      expect(html).toContain(name);
    }
    expect(html).not.toContain('<tr hidden');
  });
});

describe('who sees the roster at all', () => {
  it('an officer gets the table and its filters', async () => {
    const html = await page(await signIn('officer@example.com', APP_ROLE.Officer));
    expect(html).toContain('id="roster-search"');
  });

  it('a plain member gets nothing', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member);
    expect((await get('/admin/members', cookie)).status).toBe(403);
  });
});
