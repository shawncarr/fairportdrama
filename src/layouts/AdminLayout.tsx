import { jsxRenderer } from 'hono/jsx-renderer';
import { can } from '~/lib/auth/permissions';
import type { AppRole } from '~/db/schema/governance';

interface NavItem {
  href: string;
  label: string;
  visible: (role: AppRole) => boolean;
}

const NAV: NavItem[] = [
  { href: '/admin', label: 'Overview', visible: () => true },
  {
    href: '/admin/profile',
    label: 'My Profile',
    visible: (r) => can(r, 'memberSelf', 'update'),
  },
  {
    href: '/admin/approvals',
    label: 'Approvals',
    visible: (r) => can(r, 'memberEdit', 'approve'),
  },
  { href: '/admin/members', label: 'Members', visible: (r) => can(r, 'member', 'update') },
  {
    href: '/admin/accounts',
    label: 'Accounts',
    visible: (r) => can(r, 'account', 'invite'),
  },
  // Shows and News editors are not built yet. They are deliberately absent
  // rather than present-and-broken: a nav link that 404s is worse than a
  // missing one, because it reads as a bug in something that exists.
  { href: '/admin/audit', label: 'Activity', visible: (r) => can(r, 'audit', 'readOwn') },
];

export const adminLayout = jsxRenderer(({ children, ...props }, c) => {
  const role = c.get('role');
  const path = new URL(c.req.url).pathname;
  const title = (props as { title?: string }).title ?? 'Admin';

  // Nav is filtered by permission, not merely disabled. Showing someone a link
  // they cannot use invites them to try it and read a refusal.
  const visible = role ? NAV.filter((item) => item.visible(role)) : [];

  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="robots" content="noindex, nofollow" />
        <title>{title} | Fairport Drama Admin</title>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="stylesheet" href="/static/global.css" />
      </head>
      <body class="min-h-screen bg-neutral-100">
        <header class="bg-neutral-900 text-white">
          <div class="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <div class="flex h-14 items-center justify-between">
              <a href="/admin" class="flex items-center gap-2">
                <span aria-hidden="true">🎭</span>
                <span class="font-display font-bold">Drama Admin</span>
              </a>
              <div class="flex items-center gap-4 text-sm">
                <a href="/" class="text-neutral-300 hover:text-white">
                  View site
                </a>
                {role && (
                  <span class="px-2 py-0.5 rounded-full bg-neutral-700 text-xs uppercase tracking-wide">
                    {role}
                  </span>
                )}
                <form method="post" action="/admin/sign-out" class="inline">
                  <button type="submit" class="text-neutral-300 hover:text-white">
                    Sign out
                  </button>
                </form>
              </div>
            </div>
          </div>
        </header>

        {visible.length > 0 && (
          <nav class="bg-white border-b border-neutral-200" aria-label="Admin sections">
            <div class="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
              <ul class="flex gap-1 overflow-x-auto">
                {visible.map((item) => {
                  const active =
                    item.href === '/admin' ? path === '/admin' : path.startsWith(item.href);
                  return (
                    <li>
                      <a
                        href={item.href}
                        class={`inline-block px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                          active
                            ? 'border-primary-600 text-primary-700'
                            : 'border-transparent text-neutral-600 hover:text-neutral-900'
                        }`}
                      >
                        {item.label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          </nav>
        )}

        <main class="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-8">{children}</main>
      </body>
    </html>
  );
});
