import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import { members, MEMBER_VISIBILITY } from '~/db/schema/content';
import { invites, APP_ROLE } from '~/db/schema/governance';
import { user } from '~/db/schema/auth';
import { get, post, resetTables, signIn } from '~/test/session';

/**
 * Bulk invite, end to end.
 *
 * Two steps on purpose: eighty invitations are eighty credentials, and the
 * addresses come from a paste typed somewhere else. Nothing is written until
 * the person has seen what the list would do.
 */

const db = () => getDb(env.DB);

const bulkForm = (emails: string, role: string = APP_ROLE.Member) => {
  const form = new FormData();
  form.set('emails', emails);
  form.set('role', role);
  return form;
};

const allInvites = () => db().select().from(invites);

beforeEach(async () => {
  await resetTables(['member_offices', 'member_roles', 'members']);
});

describe('the preview step', () => {
  it('reports the count and writes nothing', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const before = (await allInvites()).length;

    const res = await post(
      '/admin/accounts/invite-bulk',
      cookie,
      bulkForm('ada@x.org\nben@x.org\ncai@x.org'),
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('3');
    expect(html).toContain('will be');
    expect((await allInvites()).length).toBe(before);
  });

  it('explains each skip, with the line it was on', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const html = await (
      await post('/admin/accounts/invite-bulk', cookie, bulkForm('ada@x.org\nrubbish'))
    ).text();

    expect(html).toContain('not an email address');
    expect(html).toContain('rubbish');
  });

  it('says so plainly when there is nobody to invite', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const html = await (
      await post('/admin/accounts/invite-bulk', cookie, bulkForm('rubbish\nalso rubbish'))
    ).text();

    expect(html).toContain('nobody on this list to invite');
    // Nothing to confirm, so no button that would send zero invitations.
    expect(html).not.toContain('invite-bulk/send');
  });

  it('refuses a role that is not a role', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const res = await post(
      '/admin/accounts/invite-bulk',
      cookie,
      bulkForm('ada@x.org', 'superuser'),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('valid+role');
  });
});

describe('the send step', () => {
  it('creates exactly the invites the preview named', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const form = new FormData();
    form.set('role', APP_ROLE.Officer);
    form.set('emails', 'ada@x.org\nben@x.org');
    const res = await post('/admin/accounts/invite-bulk/send', cookie, form);

    expect(res.headers.get('location')).toContain('bulk=2');

    const created = (await allInvites()).filter((i) => i.email !== 'board@example.com');
    expect(created.map((i) => i.email).sort()).toEqual(['ada@x.org', 'ben@x.org']);
    expect(created.every((i) => i.role === APP_ROLE.Officer)).toBe(true);
  });

  it('reports the result on the accounts page', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await (await get('/admin/accounts?bulk=74&bulkFailed=0', cookie)).text();

    expect(html).toContain('Created 74 invitations');
  });

  it('says how many could not be emailed, since they can still sign in', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await (await get('/admin/accounts?bulk=70&bulkFailed=4', cookie)).text();

    expect(html).toContain('could not be emailed');
  });
});

describe('who may do it', () => {
  it('refuses an officer, who cannot invite at all', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer);

    expect(
      (await post('/admin/accounts/invite-bulk', cookie, bulkForm('ada@x.org'))).status,
    ).toBe(403);
    expect(
      (await post('/admin/accounts/invite-bulk/send', cookie, bulkForm('ada@x.org'))).status,
    ).toBe(403);
  });

  it('refuses staff, who manage content but not access', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);

    expect(
      (await post('/admin/accounts/invite-bulk/send', cookie, bulkForm('ada@x.org'))).status,
    ).toBe(403);
    expect(await allInvites()).toHaveLength(1); // just the sign-in invite
  });
});

describe('linking an account by typed name', () => {
  beforeEach(async () => {
    await db().insert(members).values({
      id: 'ada-lovelace', name: 'Ada Lovelace', grade: 'Senior',
      visibility: MEMBER_VISIBILITY.Full, isActive: true,
    });
  });

  it('accepts the name the shared datalist offers', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const [account] = await db()
      .select()
      .from(user)
      .where(eq(user.email, 'board@example.com'));

    const form = new FormData();
    form.set('memberId', 'Ada Lovelace');
    await post(`/admin/accounts/user/${account!.id}/link`, cookie, form);

    const [after] = await db().select().from(user).where(eq(user.id, account!.id));
    expect(after!.memberId).toBe('ada-lovelace');
  });

  it('reports a name that matches nobody instead of silently unlinking', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const [account] = await db()
      .select()
      .from(user)
      .where(eq(user.email, 'board@example.com'));

    const form = new FormData();
    form.set('memberId', 'Nobody Here');
    const res = await post(`/admin/accounts/user/${account!.id}/link`, cookie, form);

    expect(decodeURIComponent(res.headers.get('location')!)).toContain('No active member');
    const [after] = await db().select().from(user).where(eq(user.id, account!.id));
    expect(after!.memberId).toBeNull();
  });

  it('clears the link when the field is emptied', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const [account] = await db()
      .select()
      .from(user)
      .where(eq(user.email, 'board@example.com'));

    const set = new FormData();
    set.set('memberId', 'Ada Lovelace');
    await post(`/admin/accounts/user/${account!.id}/link`, cookie, set);

    const clear = new FormData();
    clear.set('memberId', '');
    await post(`/admin/accounts/user/${account!.id}/link`, cookie, clear);

    const [after] = await db().select().from(user).where(eq(user.id, account!.id));
    expect(after!.memberId).toBeNull();
  });

  it('shows the linked member by name, not by slug', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const [account] = await db()
      .select()
      .from(user)
      .where(eq(user.email, 'board@example.com'));

    const form = new FormData();
    form.set('memberId', 'Ada Lovelace');
    await post(`/admin/accounts/user/${account!.id}/link`, cookie, form);

    const html = await (await get('/admin/accounts', cookie)).text();
    expect(html).toContain('value="Ada Lovelace"');
  });
});
