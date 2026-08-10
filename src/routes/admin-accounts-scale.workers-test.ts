import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '~/db/queries';
import { members, MEMBER_VISIBILITY } from '~/db/schema/content';
import { invites, APP_ROLE } from '~/db/schema/governance';
import { user } from '~/db/schema/auth';
import { generateId } from '~/lib/id';
import { get, post, resetTables, signIn } from '~/test/session';

/**
 * The accounts page at the size the club actually is.
 *
 * It used to render the full member list as a dropdown inside every account
 * row, which made the page O(accounts x members): eighty-five accounts against
 * a hundred and twenty-eight members produced 11,657 option elements and
 * 778 KB of HTML. The club has not been onboarded yet, so nothing was slow -
 * it would have become unusable in the same week everybody signed up.
 */

const db = () => getDb(env.DB);

const MEMBER_COUNT = 128;
const ACCOUNT_COUNT = 85;

/** Chunked: a single insert binding 128 rows exceeds D1's parameter limit. */
async function seedMembers() {
  const rows = Array.from({ length: MEMBER_COUNT }, (_, i) => ({
    id: `member-${i}`,
    name: `Student Number${i}`,
    grade: 'Junior',
    visibility: MEMBER_VISIBILITY.Limited,
    isActive: true,
  }));
  for (let i = 0; i < rows.length; i += 20) {
    await db().insert(members).values(rows.slice(i, i + 20));
  }
}

async function seedAccountsAndInvites() {
  for (let i = 0; i < ACCOUNT_COUNT; i++) {
    await db().insert(user).values({
      id: `user-${i}`,
      email: `student${i}@fairport.edu`,
      name: `Student Number${i}`,
      emailVerified: true,
      role: APP_ROLE.Member,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db().insert(invites).values({
      id: generateId(),
      email: `student${i}@fairport.edu`,
      role: APP_ROLE.Member,
      memberId: null,
      token: generateId(),
      expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
      createdByUserId: 'seed',
      createdAt: new Date().toISOString(),
    });
  }
}

let body: string;

beforeEach(async () => {
  await resetTables(['member_offices', 'member_roles', 'members']);
  await seedMembers();
  const cookie = await signIn('board@example.com', APP_ROLE.Admin);
  await seedAccountsAndInvites();

  const res = await get('/admin/accounts', cookie);
  expect(res.status).toBe(200);
  body = await res.text();
});

describe('the accounts page at full club size', () => {
  it('renders the member list once, not once per account', () => {
    const datalists = (body.match(/<datalist /g) ?? []).length;
    expect(datalists).toBe(1);

    // The ceiling that matters: options must not scale with accounts. One
    // datalist plus a role select per row is a few hundred; a dropdown per row
    // was eleven thousand.
    const options = (body.match(/<option /g) ?? []).length;
    expect(options).toBeLessThan(MEMBER_COUNT + ACCOUNT_COUNT * 8);
    expect(options).toBeLessThan(1000);
  });

  it('stays inside a sane payload', () => {
    // 778 KB before. The bound is deliberately loose - it is a guard against
    // the quadratic shape coming back, not a byte budget.
    expect(body.length).toBeLessThan(350 * 1024);
  });

  // Counts the rendered attribute, not the bare word: the filter script
  // contains the same string as a selector.
  const rowCount = (attr: string) =>
    (body.match(new RegExp(`${attr}=`, 'g')) ?? []).length;

  it('still shows every account and every invitation', () => {
    expect(rowCount('data-row')).toBeGreaterThanOrEqual(ACCOUNT_COUNT);
    expect(rowCount('data-invite-row')).toBeGreaterThanOrEqual(ACCOUNT_COUNT);
  });

  it('no longer silently truncates the invitations at 100', async () => {
    // The old query had `.limit(100)`, so past that the page looked complete
    // while hiding rows. Every invite is rendered; the filter narrows them.
    const shown = rowCount('data-invite-row');
    const total = (await db().select().from(invites)).length;
    expect(shown).toBe(total);
  });

  it('offers filters on both tables rather than one long scroll', () => {
    expect(body).toContain('id="accounts-search"');
    expect(body).toContain('id="invites-search"');
    expect(body).toContain('id="accounts-linked"');
  });
});

describe('bulk invite at that size', () => {
  it('previews a pasted class list without writing anything', async () => {
    const cookie = await signIn('board2@example.com', APP_ROLE.Admin);
    const before = (await db().select().from(invites)).length;

    const form = new FormData();
    form.set('role', APP_ROLE.Member);
    form.set(
      'emails',
      [
        ...Array.from({ length: 80 }, (_, i) => `fresh${i}@fairport.edu`),
        'student0@fairport.edu', // already an account
        'not-an-address',
      ].join('\n'),
    );

    const res = await post('/admin/accounts/invite-bulk', cookie, form);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('80');
    expect(html).toContain('already have an account');
    expect(html).toContain('do not look like email addresses');
    expect((await db().select().from(invites)).length).toBe(before);
  });
});
