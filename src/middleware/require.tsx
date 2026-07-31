import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '~/env';
import { can, type Action, type Resource } from '~/lib/auth/permissions';

/**
 * Requires a signed-in account with any role.
 *
 * A user row with no role is possible in principle and must fail closed: an
 * account existing is not the same as it being authorized.
 */
export const requireSignIn = createMiddleware<AppEnv>(async (c, next) => {
  const role = c.get('role');
  if (!role) {
    // Redirect rather than 403 so an unauthenticated visitor gets somewhere
    // useful, but never reveal whether the target route exists.
    return c.redirect(`/admin/sign-in?next=${encodeURIComponent(c.req.path)}`, 302);
  }
  await next();
});

/**
 * Requires a specific permission.
 *
 * Every admin route is guarded by a permission rather than a role name, so
 * changing what a role can do is a single edit in the statement rather than a
 * sweep through route definitions.
 */
export const requirePermission = <R extends Resource>(resource: R, action: Action<R>) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const role = c.get('role');
    if (!role) {
      return c.redirect(`/admin/sign-in?next=${encodeURIComponent(c.req.path)}`, 302);
    }
    if (!can(role, resource, action)) {
      c.status(403);
      return c.render(
        <div class="mx-auto max-w-2xl px-4 py-24 text-center">
          <h1 class="font-display text-3xl font-bold text-neutral-900 mb-3">
            Not allowed
          </h1>
          <p class="text-neutral-600 mb-8">
            Your account does not have permission to do that. If you think it should,
            ask a Boosters board member.
          </p>
          <a href="/admin" class="text-primary-600 hover:text-primary-700">
            Back to admin
          </a>
        </div>,
        { title: 'Not allowed' },
      );
    }
    await next();
  });

/**
 * Marks a response as private.
 *
 * Admin pages must never be cached at the edge or indexed - they render
 * per-user content including student data and audit history.
 */
export const noStore = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store, must-revalidate');
  c.header('X-Robots-Tag', 'noindex, nofollow');
});
