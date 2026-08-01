import { env } from 'cloudflare:test';
import app from '~/index';
import { getDb } from '~/db/queries';
import { invites, type AppRole } from '~/db/schema/governance';
import { verification } from '~/db/schema/auth';
import { generateId } from '~/lib/id';
import { createAuth } from '~/lib/auth';

/**
 * Drives a real invite + magic-link sign-in and returns the session cookie.
 *
 * Tests use this rather than forging a session row so that the gate, the role
 * binding, and the member link are all exercised on the way in. A test that
 * fabricated a session would keep passing if sign-in itself broke.
 */
export async function signIn(
  email: string,
  role: AppRole,
  memberId: string | null = null,
): Promise<string> {
  const db = getDb(env.DB);

  await db.insert(invites).values({
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

  const pending = await db.select().from(verification);
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

export const get = (path: string, cookie?: string) =>
  app.fetch(
    new Request(`https://fairportdrama.com${path}`, {
      headers: cookie ? { cookie } : {},
      redirect: 'manual',
    }),
    env,
  );

export const post = (path: string, cookie: string, body: FormData) =>
  app.fetch(
    new Request(`https://fairportdrama.com${path}`, {
      method: 'POST',
      headers: { cookie },
      body,
      redirect: 'manual',
    }),
    env,
  );

/** Tables cleared between tests that exercise a full request. */
export const SESSION_TABLES = [
  'audit_events',
  'pending_edits',
  'invites',
  'session',
  'account',
  'user',
  'verification',
] as const;

export async function resetTables(extra: readonly string[] = []) {
  for (const table of [...SESSION_TABLES, ...extra]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
}
