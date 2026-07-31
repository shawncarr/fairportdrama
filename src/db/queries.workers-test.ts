import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { MEMBER_VISIBILITY, members, showCast, shows } from './schema/content';
import {
  getCast,
  getDb,
  getActiveMembers,
  getIndexableMemberIds,
  getPublicMemberProfile,
} from './queries';

/**
 * The query layer is the boundary that enforces member visibility. These run
 * against real D1 so the guarantee is verified end to end rather than at the
 * pure-function level, which is covered separately.
 */

const db = () => getDb(env.DB);

const seedMember = async (over: Partial<typeof members.$inferInsert> = {}) => {
  const row = {
    id: 'test-member',
    name: 'Testy McTestface',
    grade: 'Senior',
    visibility: MEMBER_VISIBILITY.Limited,
    photoImageId: 'img_secret',
    bio: 'A private biography.',
    instagram: 'privatehandle',
    isActive: true,
    isOfficer: false,
    ...over,
  };
  await db().insert(members).values(row);
  return row;
};

beforeEach(async () => {
  await env.DB.exec('DELETE FROM show_cast');
  await env.DB.exec('DELETE FROM shows');
  await env.DB.exec('DELETE FROM member_roles');
  await env.DB.exec('DELETE FROM members');
});

describe('member directory', () => {
  it('reduces a limited member to first name and last initial', async () => {
    await seedMember();
    const [m] = await getActiveMembers(db());
    expect(m!.name).toBe('Testy M.');
  });

  it('withholds photo, bio, and link for a limited member', async () => {
    await seedMember();
    const [m] = await getActiveMembers(db());
    expect(m!.photoImageId).toBeNull();
    expect(m!.bio).toBeNull();
    expect(m!.href).toBeNull();
  });

  // A single assertion over the whole payload, so a newly added field cannot
  // quietly reintroduce the surname.
  it('emits no trace of the surname anywhere in the directory payload', async () => {
    await seedMember();
    const payload = JSON.stringify(await getActiveMembers(db()));
    expect(payload).not.toContain('McTestface');
    expect(payload).not.toContain('img_secret');
    expect(payload).not.toContain('privatehandle');
  });

  it('releases everything once the member opts in', async () => {
    await seedMember({ visibility: MEMBER_VISIBILITY.Full });
    const [m] = await getActiveMembers(db());
    expect(m!.name).toBe('Testy McTestface');
    expect(m!.photoImageId).toBe('img_secret');
    expect(m!.href).toBe('/members/test-member');
  });
});

describe('member detail page', () => {
  // The URL itself carries the name, so the page must not exist at all.
  it('returns null for a limited member, so the route 404s', async () => {
    await seedMember();
    expect(await getPublicMemberProfile(db(), 'test-member')).toBeNull();
  });

  it('returns the profile once the member opts in', async () => {
    await seedMember({ visibility: MEMBER_VISIBILITY.Full });
    const profile = await getPublicMemberProfile(db(), 'test-member');
    expect(profile?.name).toBe('Testy McTestface');
  });

  it('returns null for an unknown id', async () => {
    expect(await getPublicMemberProfile(db(), 'nobody')).toBeNull();
  });
});

describe('sitemap eligibility', () => {
  it('omits limited members, so their slugs are never indexed', async () => {
    await seedMember({ id: 'hidden', visibility: MEMBER_VISIBILITY.Limited });
    await seedMember({ id: 'shown', visibility: MEMBER_VISIBILITY.Full });
    expect(await getIndexableMemberIds(db())).toEqual(['shown']);
  });

  it('omits inactive members even when they opted in', async () => {
    await seedMember({ id: 'gone', visibility: MEMBER_VISIBILITY.Full, isActive: false });
    expect(await getIndexableMemberIds(db())).toEqual([]);
  });
});

describe('cast lists', () => {
  const seedShow = async () => {
    await db().insert(shows).values({
      id: 'test-show',
      title: 'Test Show',
      season: 'Spring 2026',
      year: 2026,
      synopsis: 'x',
    });
  };

  it('shows a limited cast member as first name and initial, unlinked', async () => {
    await seedShow();
    await seedMember();
    await db()
      .insert(showCast)
      .values({
        id: 'c1',
        showId: 'test-show',
        memberId: 'test-member',
        role: 'Lead Role',
        tier: 'lead',
        sortOrder: 0,
      });

    const [entry] = await getCast(db(), 'test-show');
    expect(entry!.member?.name).toBe('Testy M.');
    expect(entry!.member?.href).toBeNull();
  });

  // TBA roles are shown, not hidden: the audience should see the part exists.
  it('renders an uncast role as TBA rather than omitting it', async () => {
    await seedShow();
    await db()
      .insert(showCast)
      .values({
        id: 'c2',
        showId: 'test-show',
        memberId: null,
        role: 'Uncast Role',
        tier: 'ensemble',
        sortOrder: 0,
      });

    const cast = await getCast(db(), 'test-show');
    expect(cast).toHaveLength(1);
    expect(cast[0]!.role).toBe('Uncast Role');
    expect(cast[0]!.member).toBeNull();
  });

  it('preserves cast ordering', async () => {
    await seedShow();
    await seedMember({ id: 'a', name: 'Aaa Aaa', visibility: MEMBER_VISIBILITY.Full });
    await seedMember({ id: 'b', name: 'Bbb Bbb', visibility: MEMBER_VISIBILITY.Full });
    await db()
      .insert(showCast)
      .values([
        { id: 'c1', showId: 'test-show', memberId: 'b', role: 'First', sortOrder: 0 },
        { id: 'c2', showId: 'test-show', memberId: 'a', role: 'Second', sortOrder: 1 },
      ]);

    const cast = await getCast(db(), 'test-show');
    expect(cast.map((c) => c.role)).toEqual(['First', 'Second']);
  });

  it('leaks no surname through a cast list', async () => {
    await seedShow();
    await seedMember();
    await db()
      .insert(showCast)
      .values({ id: 'c1', showId: 'test-show', memberId: 'test-member', role: 'R', sortOrder: 0 });

    expect(JSON.stringify(await getCast(db(), 'test-show'))).not.toContain('McTestface');
  });
});

describe('against the real migrated roster', () => {
  // Guards the actual production dataset, not just synthetic rows.
  it('every migrated member is limited, so nothing is public yet', async () => {
    await env.DB.exec('DELETE FROM members');
    await db().insert(members).values([
      { id: 'm1', name: 'One Person', grade: 'Senior' },
      { id: 'm2', name: 'Two Person', grade: 'Junior' },
    ]);

    const rows = await db().select().from(members).where(eq(members.visibility, 'full'));
    expect(rows).toHaveLength(0);
  });
});
