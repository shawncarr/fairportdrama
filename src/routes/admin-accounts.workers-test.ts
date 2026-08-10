import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import { session, user } from '~/db/schema/auth';
import { members } from '~/db/schema/content';
import { APP_ROLE } from '~/db/schema/governance';
import { get, post, resetTables, signIn } from '~/test/session';

const db = () => getDb(env.DB);

const userId = async (email: string) =>
  (await db().select().from(user).where(eq(user.email, email)))[0]!.id;

const field = (name: string, value: string) => {
  const f = new FormData();
  f.set(name, value);
  return f;
};

beforeEach(async () => {
  await resetTables(['members']);
  await db().insert(members).values([
    { id: 'daniel-doser', name: 'Daniel Doser', grade: 'Senior' },
    { id: 'ari-toner', name: 'Ariana Toner', grade: 'Junior' },
  ]);
});

describe('changing a role', () => {
  it('promotes a member to officer', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await signIn('student@example.com', APP_ROLE.Member);
    const id = await userId('student@example.com');

    await post(`/admin/accounts/user/${id}/role`, cookie, field('role', APP_ROLE.Officer));

    const [row] = await db().select().from(user).where(eq(user.id, id));
    expect(row!.role).toBe(APP_ROLE.Officer);
  });

  it('takes effect on the next request', async () => {
    const admin = await signIn('board@example.com', APP_ROLE.Admin);
    const student = await signIn('student@example.com', APP_ROLE.Member);
    const id = await userId('student@example.com');

    expect((await get('/admin/members', student)).status).toBe(403);
    await post(`/admin/accounts/user/${id}/role`, admin, field('role', APP_ROLE.Staff));

    // The role is read from the database each request, so an existing session
    // picks the change up without signing out.
    expect((await get('/admin/members', student)).status).toBe(200);
  });

  it('refuses to strip the only admin and says why', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const id = await userId('board@example.com');

    const response = await post(
      `/admin/accounts/user/${id}/role`,
      cookie,
      field('role', APP_ROLE.Staff),
    );
    expect(response.headers.get('location')).toContain('error=');

    const [row] = await db().select().from(user).where(eq(user.id, id));
    expect(row!.role).toBe(APP_ROLE.Admin);
  });

  it('is refused to staff, who cannot manage accounts', async () => {
    await signIn('student@example.com', APP_ROLE.Member);
    const id = await userId('student@example.com');
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);

    expect(
      (await post(`/admin/accounts/user/${id}/role`, cookie, field('role', APP_ROLE.Admin)))
        .status,
    ).toBe(403);
  });
});

describe('removing access', () => {
  it('ends the session so the next request is refused', async () => {
    const admin = await signIn('board@example.com', APP_ROLE.Admin);
    const officer = await signIn('officer@example.com', APP_ROLE.Officer);
    const id = await userId('officer@example.com');

    expect((await get('/admin/approvals', officer)).status).toBe(200);

    await post(`/admin/accounts/user/${id}/revoke`, admin, new FormData());

    // Both halves matter: the sessions are gone and the cookie no longer
    // resolves. The response is a redirect to sign-in rather than a 403 -
    // they are not a signed-in user lacking a permission any more, they are
    // signed out, which is exactly what ending the session should produce.
    expect(await db().select().from(session).where(eq(session.userId, id))).toHaveLength(0);
    const after = await get('/admin/approvals', officer);
    expect(after.status).toBe(302);
    expect(after.headers.get('location')).toContain('/admin/sign-in');
  });

  it('keeps the account so it can be restored', async () => {
    const admin = await signIn('board@example.com', APP_ROLE.Admin);
    await signIn('officer@example.com', APP_ROLE.Officer);
    const id = await userId('officer@example.com');

    await post(`/admin/accounts/user/${id}/revoke`, admin, new FormData());
    expect(await db().select().from(user).where(eq(user.id, id))).toHaveLength(1);

    await post(`/admin/accounts/user/${id}/role`, admin, field('role', APP_ROLE.Member));
    const [row] = await db().select().from(user).where(eq(user.id, id));
    expect(row!.role).toBe(APP_ROLE.Member);
  });
});

describe('linking a member profile', () => {
  it('links and unlinks', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await signIn('student@example.com', APP_ROLE.Member);
    const id = await userId('student@example.com');

    await post(`/admin/accounts/user/${id}/link`, cookie, field('memberId', 'daniel-doser'));
    expect((await db().select().from(user).where(eq(user.id, id)))[0]!.memberId).toBe(
      'daniel-doser',
    );

    await post(`/admin/accounts/user/${id}/link`, cookie, field('memberId', ''));
    expect((await db().select().from(user).where(eq(user.id, id)))[0]!.memberId).toBeNull();
  });

  it('gives the linked account access to that profile', async () => {
    const admin = await signIn('board@example.com', APP_ROLE.Admin);
    const student = await signIn('student@example.com', APP_ROLE.Member);
    const id = await userId('student@example.com');

    // Before linking there is no profile to edit.
    expect(await (await get('/admin/profile', student)).text()).toContain('No profile');

    await post(`/admin/accounts/user/${id}/link`, admin, field('memberId', 'daniel-doser'));
    expect(await (await get('/admin/profile', student)).text()).toContain('Daniel D.');
  });

  it('refuses a member already linked elsewhere', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await signIn('a@example.com', APP_ROLE.Member, 'daniel-doser');
    await signIn('b@example.com', APP_ROLE.Member);
    const id = await userId('b@example.com');

    const response = await post(
      `/admin/accounts/user/${id}/link`,
      cookie,
      field('memberId', 'daniel-doser'),
    );
    expect(response.headers.get('location')).toContain('error=');
    expect((await db().select().from(user).where(eq(user.id, id)))[0]!.memberId).toBeNull();
  });

  it('does not offer an already-linked member in the shared list', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await signIn('a@example.com', APP_ROLE.Member, 'daniel-doser');
    const body = await (await get('/admin/accounts', cookie)).text();

    const datalist = body.slice(body.indexOf('<datalist'), body.indexOf('</datalist>'));

    // Ariana is free, Daniel is taken - the field should not offer a choice
    // the service will reject.
    expect(datalist).toContain('Ariana Toner');
    expect(datalist).not.toContain('Daniel Doser');
  });

  it('offers the member list once for the whole page, not once per account', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await signIn('a@example.com', APP_ROLE.Member);
    await signIn('b@example.com', APP_ROLE.Member);
    const body = await (await get('/admin/accounts', cookie)).text();

    // Re-rendering it per row made the page O(accounts x members).
    expect((body.match(/<datalist /g) ?? []).length).toBe(1);
    expect((body.match(/Ariana Toner/g) ?? []).length).toBe(1);
  });
});
