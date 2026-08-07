import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '~/db/schema';
import { auditEvents, invites, APP_ROLE } from '~/db/schema/governance';
import { AUDIT_ACTION } from '~/lib/audit/constants';
import { user, verification } from '~/db/schema/auth';
import { generateId } from '~/lib/id';
import { createAuth } from './index';

/**
 * Integration coverage for the invite gate against the real Better Auth
 * runtime and a real D1 database.
 *
 * The gate's decision logic is unit tested separately. What is verified here is
 * the wiring: that databaseHooks.user.create.before actually fires, that its
 * query works, and that a rejected signup leaves no user row behind.
 *
 * IMPORTANT: the magic-link flow creates the user at VERIFICATION, not when
 * the link is requested. Asserting after only the request step passes
 * trivially - no user exists at that point whether or not an invite matched -
 * so every test here completes the flow before asserting.
 */

const db = () => drizzle(env.DB, { schema });

const seedInvite = async (over: Partial<typeof invites.$inferInsert> = {}) => {
  const row = {
    id: generateId(),
    email: 'invited@example.com',
    role: APP_ROLE.Officer,
    memberId: null,
    token: generateId(),
    expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
    acceptedAt: null,
    revokedAt: null,
    createdByUserId: 'admin_user',
    createdAt: new Date().toISOString(),
    ...over,
  };
  await db().insert(invites).values(row);
  return row;
};

/**
 * Runs the full magic-link flow: request a link, read the token the plugin
 * stored, then verify it. Returns nothing - assertions read the database.
 */
const completeSignIn = async (email: string) => {
  const auth = createAuth(env as never);

  await auth.api
    .signInMagicLink({ body: { email, callbackURL: '/admin' }, headers: new Headers() })
    .catch(() => undefined);

  const pending = await db().select().from(verification);
  const match = pending.find((v) => String(v.value).includes(email.toLowerCase()));
  if (!match) return { verified: false as const };

  const response = await auth.handler(
    new Request(
      `https://fairportdrama.com/api/auth/magic-link/verify?token=${match.identifier}&callbackURL=/admin`,
      { redirect: 'manual' },
    ),
  );

  return { verified: true as const, status: response.status };
};

const usersFor = async (email: string) =>
  db()
    .select()
    .from(user)
    .where(eq(user.email, email.toLowerCase()));

beforeEach(async () => {
  await env.DB.exec('DELETE FROM audit_events');
  await env.DB.exec('DELETE FROM invites');
  await env.DB.exec('DELETE FROM session');
  await env.DB.exec('DELETE FROM account');
  await env.DB.exec('DELETE FROM user');
  await env.DB.exec('DELETE FROM verification');
});

describe('the gate admits invited addresses', () => {
  // Guards against the whole suite passing because nothing ever succeeds.
  it('creates a user for a valid open invite', async () => {
    await seedInvite({ email: 'invited@example.com', role: APP_ROLE.Officer });
    await completeSignIn('invited@example.com');

    const rows = await usersFor('invited@example.com');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe(APP_ROLE.Officer);
  });

  it('takes the role from the invite, not from anything client-supplied', async () => {
    await seedInvite({ email: 'boss@example.com', role: APP_ROLE.Admin });
    await completeSignIn('boss@example.com');

    const rows = await usersFor('boss@example.com');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe(APP_ROLE.Admin);
  });

  it('binds the member record when the invite names one', async () => {
    await seedInvite({ email: 'student@example.com', memberId: 'daniel-doser' });
    await completeSignIn('student@example.com');

    const rows = await usersFor('student@example.com');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.memberId).toBe('daniel-doser');
  });

  it('leaves memberId null for a board member with no profile', async () => {
    await seedInvite({ email: 'board@example.com', role: APP_ROLE.Admin, memberId: null });
    await completeSignIn('board@example.com');

    const rows = await usersFor('board@example.com');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.memberId).toBeNull();
  });

  it('consumes the invite so it cannot be reused', async () => {
    await seedInvite({ email: 'once@example.com' });
    await completeSignIn('once@example.com');

    const [row] = await db()
      .select()
      .from(invites)
      .where(eq(invites.email, 'once@example.com'));
    expect(row!.acceptedAt).not.toBeNull();
  });
});

describe('the gate rejects everything else', () => {
  // The central rule: authenticating proves identity, not authorization.
  it('creates no user for an address with no invite', async () => {
    await completeSignIn('stranger@example.com');
    expect(await usersFor('stranger@example.com')).toHaveLength(0);
  });

  it('creates no user for a revoked invite', async () => {
    await seedInvite({ email: 'revoked@example.com', revokedAt: new Date().toISOString() });
    await completeSignIn('revoked@example.com');
    expect(await usersFor('revoked@example.com')).toHaveLength(0);
  });

  it('creates no user for an expired invite', async () => {
    await seedInvite({
      email: 'expired@example.com',
      expiresAt: new Date(Date.now() - 864e5).toISOString(),
    });
    await completeSignIn('expired@example.com');
    expect(await usersFor('expired@example.com')).toHaveLength(0);
  });

  it('creates no user for an already-accepted invite', async () => {
    await seedInvite({
      email: 'used@example.com',
      acceptedAt: new Date().toISOString(),
    });
    await completeSignIn('used@example.com');
    expect(await usersFor('used@example.com')).toHaveLength(0);
  });

  it('leaves no user table rows at all after a rejected signup', async () => {
    await completeSignIn('nobody@example.com');
    expect(await db().select().from(user)).toHaveLength(0);
  });
});

describe('the gate cannot be bypassed', () => {
  it('matches invites case-insensitively rather than treating casing as a new address', async () => {
    await seedInvite({ email: 'mixed@example.com', role: APP_ROLE.Member });
    await completeSignIn('MIXED@example.com');

    const all = await db().select().from(user);
    // Must not produce an uninvited account under a different casing.
    for (const row of all) {
      expect(row.email.toLowerCase()).toBe('mixed@example.com');
    }
  });

  it('does not let one address consume another address invite', async () => {
    await seedInvite({ email: 'legit@example.com', role: APP_ROLE.Admin });
    await completeSignIn('attacker@example.com');

    expect(await usersFor('attacker@example.com')).toHaveLength(0);
    const [inv] = await db()
      .select()
      .from(invites)
      .where(eq(invites.email, 'legit@example.com'));
    expect(inv!.acceptedAt).toBeNull();
  });
});

describe('schema compatibility', () => {
  // The Better Auth schema was generated by CLI 1.4.21 while the runtime is
  // 1.6.25. A successful end-to-end signup above already proves the adapter can
  // read and write every column it needs, but assert the handler routes too.
  it('the generated tables satisfy the running Better Auth version', async () => {
    const auth = createAuth(env as never);
    const response = await auth.handler(
      new Request('https://fairportdrama.com/api/auth/ok'),
    );
    expect(response.status).toBeLessThan(500);
  });
});

describe('the account lifecycle is recorded', () => {
  /**
   * Account creation is how somebody gains access, and a refused attempt
   * writes no row at all - so without these the two most security-relevant
   * events in the system leave no trace. Both actions were declared in the
   * audit vocabulary from the start and neither was ever emitted.
   */
  const audits = () => db().select().from(auditEvents);

  it('records the acceptance, with the role that was granted', async () => {
    await seedInvite({ email: 'invited@example.com', role: APP_ROLE.Admin });
    await completeSignIn('invited@example.com');

    const rows = (await audits()).filter(
      (r) => r.action === AUDIT_ACTION.AccountInviteAccepted,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      email: 'invited@example.com',
      role: APP_ROLE.Admin,
    });

    // Targets the account, so the row resolves against the user table.
    const [account] = await db()
      .select()
      .from(user)
      .where(eq(user.email, 'invited@example.com'));
    expect(rows[0]!.targetId).toBe(account!.id);
  });

  it('records a refused sign-in for an address nobody invited', async () => {
    const auth = createAuth(env as never);
    await auth.api
      .signInMagicLink({
        body: { email: 'stranger@example.com', callbackURL: '/admin' },
        headers: new Headers(),
      })
      .catch(() => undefined);

    const rows = (await audits()).filter((r) => r.action === AUDIT_ACTION.AuthSignInDenied);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetId).toBe('stranger@example.com');
    expect(rows[0]!.payload).toMatchObject({ method: 'magic-link' });
    // Nothing was created, which is the point of the gate.
    expect(await db().select().from(user)).toHaveLength(0);
  });

  it('records a refusal for a revoked invite too', async () => {
    await seedInvite({ email: 'revoked@example.com', revokedAt: new Date().toISOString() });

    const auth = createAuth(env as never);
    await auth.api
      .signInMagicLink({
        body: { email: 'revoked@example.com', callbackURL: '/admin' },
        headers: new Headers(),
      })
      .catch(() => undefined);

    const rows = (await audits()).filter((r) => r.action === AUDIT_ACTION.AuthSignInDenied);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetId).toBe('revoked@example.com');
  });

  it('records nothing for an address that is entitled', async () => {
    await seedInvite({ email: 'invited@example.com' });

    const auth = createAuth(env as never);
    await auth.api
      .signInMagicLink({
        body: { email: 'invited@example.com', callbackURL: '/admin' },
        headers: new Headers(),
      })
      .catch(() => undefined);

    expect((await audits()).filter((r) => r.action === AUDIT_ACTION.AuthSignInDenied)).toHaveLength(0);
  });
});
