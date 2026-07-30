import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '~/env';
import { AUDIT_ACTOR_KIND, systemActor, type Actor } from '~/lib/audit/actor';

/**
 * Resolves the audit actor exactly once per request.
 *
 * Every mutation reads `c.get('actor')` rather than reconstructing an actor
 * from a session or a passed-in user id. This is deliberate: reconstructing
 * the actor at each call site is how attribution drifts, and how rows end up
 * claiming `kind: user` with a null id.
 *
 * The actor kind, id, and label are resolved together as a unit. A request
 * without a session is a `system` actor, never a user actor with a missing id.
 */
export const actorMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const ip = c.req.header('CF-Connecting-IP') ?? null;
  const userAgent = c.req.header('User-Agent') ?? null;

  const session = await resolveSession(c);

  const actor: Actor = session
    ? {
        kind: AUDIT_ACTOR_KIND.User,
        id: session.userId,
        label: session.label,
        ip,
        userAgent,
      }
    : systemActor(ip, userAgent);

  c.set('actor', actor);
  await next();
});

interface ResolvedSession {
  userId: string;
  label: string | null;
}

/**
 * Placeholder until Better Auth is mounted. Returning null here means every
 * request currently resolves to the system actor, which is the correct
 * fail-safe: unattributed, not misattributed.
 */
async function resolveSession(
  _c: Parameters<Parameters<typeof createMiddleware<AppEnv>>[0]>[0],
): Promise<ResolvedSession | null> {
  return null;
}
