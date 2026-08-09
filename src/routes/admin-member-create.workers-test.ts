import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import { members, MEMBER_VISIBILITY } from '~/db/schema/content';
import { invites, APP_ROLE } from '~/db/schema/governance';
import { get, post, resetTables, signIn } from '~/test/session';

const db = () => getDb(env.DB);

const memberForm = (over: Record<string, string> = {}) => {
  const form = new FormData();
  form.set('name', 'Nora Whitfield');
  form.set('grade', 'Freshman');
  form.set('graduationYear', '2029');
  for (const [k, v] of Object.entries(over)) form.set(k, v);
  return form;
};

const roster = () => db().select().from(members);

beforeEach(async () => {
  await resetTables(['show_cast', 'show_crew', 'show_gallery_images', 'shows', 'members']);
});

describe('adding a member', () => {
  it('creates them hidden, with the id taken from the name', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const response = await post('/admin/members/new', cookie, memberForm());
    expect(response.status).toBe(302);

    const [row] = await roster();
    expect(row!.id).toBe('nora-whitfield');
    expect(row!.visibility).toBe(MEMBER_VISIBILITY.Limited);
    expect(row!.graduationYear).toBe(2029);
  });

  it('does not invite anyone when no email is given', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post('/admin/members/new', cookie, memberForm());

    // Most members never sign in; they exist only to appear in a program.
    expect(await db().select().from(invites)).toHaveLength(1); // just the signIn invite
  });

  it('creates the member and the invite together when an email is given', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    await post(
      '/admin/members/new',
      cookie,
      memberForm({ email: 'nora@example.com', role: APP_ROLE.Member }),
    );

    const [invite] = await db()
      .select()
      .from(invites)
      .where(eq(invites.email, 'nora@example.com'));
    expect(invite!.memberId).toBe('nora-whitfield');
    expect(invite!.role).toBe(APP_ROLE.Member);
  });

  it('keeps the member when the invite is rejected', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const response = await post(
      '/admin/members/new',
      cookie,
      memberForm({ email: 'not-an-address', role: APP_ROLE.Member }),
    );

    // Losing the roster entry would mean retyping it to try the invite again.
    expect(await roster()).toHaveLength(1);
    expect(response.headers.get('location')).toContain('inviteError=');
  });
});

describe('officer status', () => {
  // Offices moved to their own table, so a new member never arrives holding
  // one. The create form no longer offers it at all, to anybody.
  it('is not something the create form can set', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const body = await (await get('/admin/members/new', cookie)).text();

    expect(body).toContain('Full name');
    expect(body).not.toContain('name="isOfficer"');
    expect(body).not.toContain('name="officerTitle"');
  });

  it('is refused to an officer even by hand, since setOfficer gates it', async () => {
    await signIn('board@example.com', APP_ROLE.Admin);
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);
    await post('/admin/members/new', cookie, memberForm());
    const [row] = await roster();

    const form = new FormData();
    form.set('title', 'President');
    form.set('startYear', '2026');
    expect(
      (await post(`/admin/members/${row!.id}/offices`, cookie, form)).status,
    ).toBe(403);
  });
});

describe('who can add members', () => {
  it('lets an officer add one', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);
    expect((await get('/admin/members/new', cookie)).status).toBe(200);

    await post('/admin/members/new', cookie, memberForm());
    expect(await roster()).toHaveLength(1);
  });

  it('does not offer an officer the invite fields, since they cannot invite', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);
    const body = await (await get('/admin/members/new', cookie)).text();
    expect(body).not.toContain('name="email"');
  });

  it('ignores an email an officer posts by hand', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);
    await post(
      '/admin/members/new',
      cookie,
      memberForm({ email: 'sneaky@example.com', role: APP_ROLE.Admin }),
    );

    const sneaky = await db()
      .select()
      .from(invites)
      .where(eq(invites.email, 'sneaky@example.com'));
    expect(sneaky).toHaveLength(0);
  });

  it('refuses a plain member', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member);
    expect((await get('/admin/members/new', cookie)).status).toBe(403);
    expect((await post('/admin/members/new', cookie, memberForm())).status).toBe(403);
    expect(await roster()).toHaveLength(0);
  });
});

describe('a name already on the roster', () => {
  it('shows the existing member instead of creating a second one', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post('/admin/members/new', cookie, memberForm());

    const response = await post('/admin/members/new', cookie, memberForm());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('already on the roster');
    expect(body).toContain('nora-whitfield-2');
    expect(await roster()).toHaveLength(1);
  });

  it('keeps what was typed so the conflict does not cost the entry', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post('/admin/members/new', cookie, memberForm());

    const body = await (
      await post('/admin/members/new', cookie, memberForm({ graduationYear: '2030' }))
    ).text();
    expect(body).toContain('value="Nora Whitfield"');
    expect(body).toContain('value="2030"');
  });

  it('creates the second record once confirmed', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post('/admin/members/new', cookie, memberForm());

    await post('/admin/members/new', cookie, memberForm({ allowDuplicate: '1' }));
    expect((await roster()).map((m) => m.id).sort()).toEqual([
      'nora-whitfield',
      'nora-whitfield-2',
    ]);
  });

  it('offers to reactivate rather than duplicate when the holder is inactive', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await post('/admin/members/new', cookie, memberForm());
    await db().update(members).set({ isActive: false }).where(eq(members.id, 'nora-whitfield'));

    const body = await (await post('/admin/members/new', cookie, memberForm())).text();
    expect(body).toContain('/admin/members/nora-whitfield/reactivate');

    await post('/admin/members/nora-whitfield/reactivate', cookie, new FormData());
    const [row] = await roster();
    expect(row!.isActive).toBe(true);
    expect(await roster()).toHaveLength(1);
  });
});
