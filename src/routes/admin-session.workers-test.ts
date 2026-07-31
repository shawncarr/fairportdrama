import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import app from '~/index';
import { getDb } from '~/db/queries';
import { members, MEMBER_VISIBILITY } from '~/db/schema/content';
import { invites, APP_ROLE, type AppRole } from '~/db/schema/governance';
import { user, verification } from '~/db/schema/auth';
import { auditEvents } from '~/db/schema/governance';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { generateId } from '~/lib/id';
import { createAuth } from '~/lib/auth';

/**
 * End-to-end coverage of a real signed-in session.
 *
 * Everything else exercises the locked state. This walks the whole chain -
 * invite, sign-in, session cookie, role resolution, page render - so that a
 * break anywhere between Better Auth and the permission statement surfaces.
 */

const db = () => getDb(env.DB);

/** Completes the invite + magic-link flow and returns the session cookie. */
async function signIn(email: string, role: AppRole, memberId: string | null) {
  await db()
    .insert(invites)
    .values({
      id: generateId(),
      email,
      role,
      memberId,
      token: generateId(),
      expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
      createdByUserId: 'seed',
      createdAt: new Date().toISOString(),
    });

  const auth = createAuth(env as never);
  await auth.api
    .signInMagicLink({ body: { email, callbackURL: '/admin' }, headers: new Headers() })
    .catch(() => undefined);

  const pending = await db().select().from(verification);
  const match = pending.find((v) => String(v.value).includes(email.toLowerCase()));
  if (!match) throw new Error('no magic link issued');

  const response = await auth.handler(
    new Request(
      `https://fairportdrama.com/api/auth/magic-link/verify?token=${match.identifier}&callbackURL=/admin`,
      { redirect: 'manual' },
    ),
  );

  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('no session cookie issued');
  return cookie.split(';')[0]!;
}

const get = (path: string, cookie: string) =>
  app.fetch(
    new Request(`https://fairportdrama.com${path}`, {
      headers: { cookie },
      redirect: 'manual',
    }),
    env,
  );

beforeEach(async () => {
  await env.DB.exec('DELETE FROM audit_events');
  await env.DB.exec('DELETE FROM pending_edits');
  await env.DB.exec('DELETE FROM invites');
  await env.DB.exec('DELETE FROM session');
  await env.DB.exec('DELETE FROM account');
  await env.DB.exec('DELETE FROM user');
  await env.DB.exec('DELETE FROM verification');
  await env.DB.exec('DELETE FROM members');

  await db().insert(members).values({
    id: 'daniel-doser',
    name: 'Daniel Doser',
    grade: 'Senior',
    visibility: MEMBER_VISIBILITY.Limited,
    bio: 'Original bio.',
  });
});

describe('a signed-in member', () => {
  it('reaches the admin overview', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    const response = await get('/admin', cookie);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Overview');
  });

  it('sees their own profile page with their current visibility', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    const body = await (await get('/admin/profile', cookie)).text();
    expect(body).toContain('My Profile');
    // The preview must show the reduced form, not the stored full name.
    expect(body).toContain('Daniel D.');
  });

  // The permission boundary, exercised through a real session rather than a
  // unit call to can().
  it('cannot reach approvals', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    const response = await get('/admin/approvals', cookie);
    expect(response.status).toBe(403);
  });

  it('cannot reach the member roster', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    expect((await get('/admin/members', cookie)).status).toBe(403);
  });

  it('sees no approvals or members links in the nav', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    const body = await (await get('/admin', cookie)).text();
    expect(body).not.toContain('href="/admin/approvals"');
    expect(body).not.toContain('href="/admin/members"');
  });
});

describe('a signed-in officer', () => {
  it('reaches approvals', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer, 'daniel-doser');
    const response = await get('/admin/approvals', cookie);
    expect(response.status).toBe(200);
  });

  it('is warned that their name is recorded on every decision', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer, 'daniel-doser');
    const body = await (await get('/admin/approvals', cookie)).text();
    expect(body).toContain('Your name is recorded');
  });

  it('cannot reach account management', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer, null);
    expect((await get('/admin/accounts', cookie)).status).toBe(404);
  });
});

describe('a signed-in admin', () => {
  it('reaches the member roster and sees the release warning', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin, null);
    const body = await (await get('/admin/members', cookie)).text();
    expect(body).toContain('photo release is on file');
  });

  it('sees IP addresses in the activity log', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin, null);
    // The IP column only exists once there is something to show, so seed a row.
    await db().insert(auditEvents).values({
      id: generateId(),
      actorKind: 'user',
      actorUserId: 'someone',
      actorLabel: 'Someone',
      action: AUDIT_ACTION.MemberUpdated,
      targetKind: AUDIT_ENTITY_KIND.Member,
      targetId: 'daniel-doser',
      ip: '203.0.113.42',
      relatedEntities: [],
      createdAt: new Date().toISOString(),
    });

    const body = await (await get('/admin/audit', cookie)).text();
    expect(body).toContain('203.0.113.42');
  });

  // An unlinked account is the normal case for a board member.
  it('is told they have no public profile rather than shown a broken one', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin, null);
    const body = await (await get('/admin', cookie)).text();
    expect(body).toContain('not linked to a member profile');
  });
});

describe('the activity log is scoped by role', () => {
  it('hides IP addresses from a member', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    await db().insert(auditEvents).values({
      id: generateId(),
      actorKind: 'user',
      actorUserId: 'someone-else',
      actorLabel: 'Someone Else',
      action: AUDIT_ACTION.MemberUpdated,
      targetKind: AUDIT_ENTITY_KIND.Member,
      targetId: 'daniel-doser',
      ip: '203.0.113.42',
      relatedEntities: [],
      createdAt: new Date().toISOString(),
    });
    const response = await get('/admin/audit', cookie);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('Changes you made');
    // Asserted against a row that definitely exists, so this proves the column
    // is withheld rather than that the table simply had nothing to render.
    expect(body).not.toContain('203.0.113.42');
  });
});

describe('the session actually carries identity', () => {
  it('resolves the role from the invite onto the session', async () => {
    const cookie = await signIn('officer@example.com', APP_ROLE.Officer, 'daniel-doser');
    const body = await (await get('/admin', cookie)).text();
    // The layout renders the role badge from the resolved session.
    expect(body).toContain('officer');
  });

  it('links the member record named on the invite', async () => {
    await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    const [row] = await db()
      .select()
      .from(user)
      .where(eq(user.email, 'student@example.com'));
    expect(row!.memberId).toBe('daniel-doser');
  });
});
