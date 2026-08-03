import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '~/env';
import { createAuth } from '~/lib/auth';
import { AUDIT_ACTOR_KIND, systemActor, type Actor } from '~/lib/audit/actor';
import { getImageStore } from '~/lib/images';
import type { AppRole } from '~/db/schema/governance';

/**
 * Resolves the request's identity exactly once.
 *
 * Every mutation reads `c.get('actor')` rather than reconstructing an actor
 * from a session or a passed-in user id. Reconstructing at the call site is how
 * attribution drifts, and how rows end up claiming `kind: user` while carrying
 * a null id - a defect nothing fails on at write time.
 *
 * Kind, id, and label are resolved together as a unit. A request without a
 * session is a `system` actor, never a user actor with a missing id.
 */
export const actorMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const ip = c.req.header('CF-Connecting-IP') ?? null;
  const userAgent = c.req.header('User-Agent') ?? null;

  let actor: Actor = systemActor(ip, userAgent);
  let role: AppRole | null = null;
  let memberId: string | null = null;

  try {
    const auth = createAuth(c.env);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (session?.user) {
      const u = session.user as typeof session.user & {
        role?: string | null;
        memberId?: string | null;
      };

      actor = {
        kind: AUDIT_ACTOR_KIND.User,
        id: u.id,
        // `||`, not `??`: a magic-link signup has no name and Better Auth
        // stores an empty string rather than null, which `??` would happily
        // keep - leaving every audit row that user writes with a blank "who".
        label: u.name?.trim() || u.email || null,
        ip,
        userAgent,
      };
      role = (u.role as AppRole | undefined) ?? null;
      memberId = u.memberId ?? null;
    }
  } catch {
    // A failure to read the session is not an authorization decision. Fall
    // through as the system actor with no role, which grants nothing.
  }

  c.set('images', getImageStore(c.env, c.req.url));
  c.set('actor', actor);
  c.set('role', role);
  c.set('memberId', memberId);

  await next();
});
