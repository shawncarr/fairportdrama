import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '~/db/queries';
import { memberOffices, memberRoles, members, MEMBER_VISIBILITY } from '~/db/schema/content';
import { get, resetTables } from '~/test/session';

/**
 * The member directory's shape.
 *
 * The page had regressed to one flat run of 128 cards. Grouping is the whole
 * point of it: a visitor is looking for a person or a class, and neither is
 * findable in an unbroken alphabetical list.
 */

const db = () => getDb(env.DB);

const body = async (path: string) => {
  const res = await get(path);
  expect(res.status).toBe(200);
  return res.text();
};

/** Section order, ignoring anything that is not a heading. */
const sections = (html: string) =>
  [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/gs)].map((m) =>
    m[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  );

beforeEach(async () => {
  await resetTables(['member_offices', 'member_roles', 'members']);

  await db().insert(members).values([
    { id: 'sen-a', name: 'Anna Senior', grade: 'Senior', visibility: MEMBER_VISIBILITY.Full, isActive: true },
    { id: 'sen-b', name: 'Bob Senior', grade: 'Senior', visibility: MEMBER_VISIBILITY.Full, isActive: true },
    { id: 'jun-c', name: 'Cara Junior', grade: 'Junior', visibility: MEMBER_VISIBILITY.Full, isActive: true },
    { id: 'fresh-d', name: 'Dan Fresh', grade: 'Freshman', visibility: MEMBER_VISIBILITY.Full, isActive: true },
    { id: 'fac-e', name: 'Ed Faculty', grade: 'Faculty', visibility: MEMBER_VISIBILITY.Full, isActive: true },
    { id: 'alum-f', name: 'Fay Alum', grade: 'Alumni', visibility: MEMBER_VISIBILITY.Full, isActive: true },
    { id: 'gone-g', name: 'Gus Gone', grade: 'Senior', visibility: MEMBER_VISIBILITY.Full, isActive: false },
  ]);
});

describe('grouping', () => {
  it('runs officers, then oldest to youngest, then faculty', async () => {
    await db().insert(memberOffices).values({
      id: 'o1', memberId: 'jun-c', title: 'President', startYear: 2026, endYear: null,
    });

    expect(sections(await body('/members'))).toEqual([
      'Club Officers 1',
      'Seniors 2',
      'Sophomores 0',
      'Freshmen 1',
      'Faculty 1',
    ].filter((s) => !s.endsWith(' 0')));
  });

  it('counts each section', async () => {
    const html = await body('/members');
    expect(html).toMatch(/Seniors.*?>\s*2\s*</s);
  });

  it('omits a grade nobody is in rather than printing an empty heading', async () => {
    expect(sections(await body('/members'))).not.toContain('Sophomores 0');
  });

  it('leaves inactive members off entirely', async () => {
    const html = await body('/members');
    expect(html).not.toContain('Gus Gone');
    // Two seniors, not three.
    expect(sections(html)).toContain('Seniors 2');
  });

  it('lists an officer once, in the officers section only', async () => {
    await db().insert(memberOffices).values({
      id: 'o1', memberId: 'sen-a', title: 'Treasurer', startYear: 2026, endYear: null,
    });

    const html = await body('/members');
    expect(html.match(/Anna Senior/g)).toHaveLength(1);
    expect(sections(html)).toContain('Seniors 1');
  });

  it('orders officers by office, not alphabetically', async () => {
    await db().insert(memberOffices).values([
      { id: 'o1', memberId: 'sen-a', title: 'Treasurer', startYear: 2026, endYear: null },
      { id: 'o2', memberId: 'sen-b', title: 'President', startYear: 2026, endYear: null },
    ]);

    const html = await body('/members');
    // Bob before Anna: a playbill leads with the president.
    expect(html.indexOf('Bob Senior')).toBeLessThan(html.indexOf('Anna Senior'));
  });

  it('sorts an unranked office last rather than above the president', async () => {
    await db().insert(memberOffices).values([
      { id: 'o1', memberId: 'sen-a', title: 'Historian', startYear: 2026, endYear: null },
      { id: 'o2', memberId: 'sen-b', title: 'President', startYear: 2026, endYear: null },
    ]);

    const html = await body('/members');
    expect(html.indexOf('Bob Senior')).toBeLessThan(html.indexOf('Anna Senior'));
  });

  it('still shows a grade the order does not name', async () => {
    await db().insert(members).values({
      id: 'odd-h', name: 'Hal Odd', grade: 'Postgraduate',
      visibility: MEMBER_VISIBILITY.Full, isActive: true,
    });

    // Whatever it is, it cannot silently vanish from the directory.
    const html = await body('/members');
    expect(html).toContain('Hal Odd');
    expect(sections(html)).toContain('Everyone else 1');
  });
});

describe('alumni', () => {
  it('are not on the directory', async () => {
    const html = await body('/members');
    expect(html).not.toContain('Fay Alum');
    expect(sections(html)).not.toContain('Alumni 1');
  });

  it('are linked from it, with a count', async () => {
    expect(await body('/members')).toContain('/members/alumni');
  });

  it('have their own page', async () => {
    const html = await body('/members/alumni');
    expect(html).toContain('Fay Alum');
    // Only alumni: this is not a second copy of the directory.
    expect(html).not.toContain('Anna Senior');
  });

  it('resolve /members/alumni as the page, not as a member slug', async () => {
    await db().insert(members).values({
      id: 'alumni', name: 'Alumni Person', grade: 'Senior',
      visibility: MEMBER_VISIBILITY.Full, isActive: true,
    });

    // The literal route is registered first, so a member who happens to slug
    // to "alumni" cannot take the page over.
    expect(await body('/members/alumni')).toContain('Former members');
  });

  it('say so plainly when there are none', async () => {
    await db().delete(members);
    expect(await body('/members/alumni')).toContain('No alumni are listed yet');
  });

  it('drop off the directory when a member graduates', async () => {
    const { advanceGrades } = await import('~/services/members');
    const before = await body('/members');
    expect(before).toContain('Anna Senior');

    await advanceGrades(db(), {
      kind: 'user', id: 'u', label: 'Board', ip: null, userAgent: null,
    } as never, 2026);

    const after = await body('/members');
    expect(after).not.toContain('Anna Senior');
    expect(await body('/members/alumni')).toContain('Anna Senior');
  });
});

describe('filtering', () => {
  beforeEach(async () => {
    await db().insert(memberRoles).values([
      { memberId: 'sen-a', role: 'lighting' },
      { memberId: 'jun-c', role: 'actor' },
    ]);
  });

  it('offers a search box and the roles actually in use', async () => {
    const html = await body('/members');

    expect(html).toContain('id="member-search"');
    expect(html).toContain('value="lighting"');
    expect(html).toContain('Lighting');
    // Not every role in the vocabulary - only the ones somebody holds.
    expect(html).not.toContain('value="choreographer"');
  });

  it('drops the role filter when nobody has a role', async () => {
    await db().delete(memberRoles);
    const html = await body('/members');

    expect(html).toContain('id="member-search"');
    expect(html).not.toContain('id="member-role"');
  });

  it('tags each card with the name and roles it filters on', async () => {
    const html = await body('/members');

    expect(html).toContain('data-name="anna senior"');
    expect(html).toContain('data-roles="lighting"');
  });

  it('renders every member up front, so no-JavaScript sees the whole list', async () => {
    const html = await body('/members');

    // The filter hides cards that are already in the page. If the server
    // pre-filtered, a visitor without JavaScript would get a short list and
    // an inert search box.
    for (const name of ['Anna Senior', 'Bob Senior', 'Cara Junior', 'Dan Fresh']) {
      expect(html).toContain(name);
    }
    expect(html).not.toContain('hidden data-member');
  });

  it('does not expose a hidden member’s surname to the filter', async () => {
    await db().insert(members).values({
      id: 'shy-i', name: 'Iris Ivanov', grade: 'Junior',
      visibility: MEMBER_VISIBILITY.Limited, isActive: true,
    });

    const html = await body('/members');
    expect(html).toContain('data-name="iris i."');
    expect(html).not.toContain('Ivanov');
  });
});
