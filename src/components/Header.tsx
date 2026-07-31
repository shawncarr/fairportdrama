import { html } from 'hono/html';

interface NavItem {
  name: string;
  href?: string;
  children?: { name: string; href: string }[];
}

const navigation: NavItem[] = [
  { name: 'Home', href: '/' },
  {
    name: 'Shows',
    children: [
      { name: 'Current Show', href: '/shows/current' },
      { name: 'Past Shows', href: '/shows/past' },
    ],
  },
  { name: 'Members', href: '/members' },
  { name: 'Spirit Wear', href: '/spiritwear' },
  { name: 'News', href: '/news' },
  {
    name: 'About',
    children: [
      { name: 'Boosters', href: '/about/boosters' },
      { name: 'Sponsors', href: '/about/sponsors' },
      { name: 'Contact', href: '/about/contact' },
    ],
  },
];

const ACTIVE = 'text-primary-600 bg-primary-50';
const IDLE = 'text-neutral-700 hover:text-primary-600 hover:bg-neutral-100';

export function Header({ path }: { path: string }) {
  const isActive = (href: string) =>
    href === '/' ? path === '/' : path.startsWith(href);

  const navItemClass = (item: NavItem) => {
    const active = item.children
      ? item.children.some((c) => isActive(c.href))
      : isActive(item.href!);
    return active ? ACTIVE : IDLE;
  };

  return (
    <header class="bg-white shadow-sm sticky top-0 z-50">
      <nav class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8" aria-label="Main navigation">
        <div class="flex h-16 items-center justify-between">
          <div class="flex-shrink-0">
            <a
              href="/"
              class="flex items-center gap-2 group"
              aria-label="Fairport Drama Club Home"
            >
              <span class="text-2xl" aria-hidden="true">
                🎭
              </span>
              <span class="font-display font-bold text-xl text-primary-600 group-hover:text-primary-700 transition-colors">
                Fairport Drama
              </span>
            </a>
          </div>

          <div class="hidden md:flex md:items-center md:gap-1">
            {navigation.map((item) =>
              item.children ? (
                <div class="relative group">
                  <button
                    type="button"
                    class={`inline-flex items-center gap-1 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${navItemClass(item)}`}
                    aria-expanded="false"
                    aria-haspopup="true"
                  >
                    {item.name}
                    <Chevron class="h-4 w-4 transition-transform group-hover:rotate-180" />
                  </button>
                  <div class="absolute left-0 top-full pt-2 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200">
                    <div class="bg-white rounded-lg shadow-lg ring-1 ring-black/5 py-2 min-w-[180px]">
                      {item.children.map((child) => (
                        <a
                          href={child.href}
                          class={`block px-4 py-2 text-sm transition-colors ${
                            isActive(child.href)
                              ? ACTIVE
                              : 'text-neutral-700 hover:text-primary-600 hover:bg-neutral-50'
                          }`}
                        >
                          {child.name}
                        </a>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <a
                  href={item.href}
                  class={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${navItemClass(item)}`}
                >
                  {item.name}
                </a>
              ),
            )}
          </div>

          <div class="md:hidden">
            <button
              type="button"
              id="mobile-menu-button"
              class="inline-flex items-center justify-center p-2 rounded-lg text-neutral-700 hover:text-primary-600 hover:bg-neutral-100 transition-colors"
              aria-expanded="false"
              aria-controls="mobile-menu"
              aria-label="Open main menu"
            >
              <svg class="h-6 w-6 menu-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M4 6h16M4 12h16M4 18h16"
                />
              </svg>
              <svg
                class="h-6 w-6 close-icon hidden"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        <div id="mobile-menu" class="hidden md:hidden pb-4">
          <div class="space-y-1">
            {navigation.map((item) =>
              item.children ? (
                <div class="mobile-dropdown">
                  <button
                    type="button"
                    class="mobile-dropdown-button w-full flex items-center justify-between px-4 py-3 text-base font-medium text-neutral-700 hover:text-primary-600 hover:bg-neutral-50 rounded-lg transition-colors"
                    aria-expanded="false"
                  >
                    {item.name}
                    <Chevron class="h-5 w-5 transition-transform" />
                  </button>
                  <div class="mobile-dropdown-content hidden pl-4 space-y-1">
                    {item.children.map((child) => (
                      <a
                        href={child.href}
                        class={`block px-4 py-2 text-base transition-colors rounded-lg ${
                          isActive(child.href)
                            ? ACTIVE
                            : 'text-neutral-600 hover:text-primary-600 hover:bg-neutral-50'
                        }`}
                      >
                        {child.name}
                      </a>
                    ))}
                  </div>
                </div>
              ) : (
                <a
                  href={item.href}
                  class={`block px-4 py-3 text-base font-medium rounded-lg transition-colors ${
                    isActive(item.href!)
                      ? ACTIVE
                      : 'text-neutral-700 hover:text-primary-600 hover:bg-neutral-50'
                  }`}
                >
                  {item.name}
                </a>
              ),
            )}
          </div>
        </div>
      </nav>

      {/* Cross-document view transitions reload the document on navigation, so
          this runs fresh each time. The Astro version additionally re-ran on
          `astro:after-swap` because ClientRouter swapped the DOM in place. */}
      {html`
        <script>
          (function () {
            var button = document.getElementById('mobile-menu-button');
            var menu = document.getElementById('mobile-menu');
            if (button && menu) {
              button.addEventListener('click', function () {
                var expanded = button.getAttribute('aria-expanded') === 'true';
                button.setAttribute('aria-expanded', String(!expanded));
                menu.classList.toggle('hidden');
                var m = button.querySelector('.menu-icon');
                var c = button.querySelector('.close-icon');
                if (m) m.classList.toggle('hidden');
                if (c) c.classList.toggle('hidden');
              });
            }
            document.querySelectorAll('.mobile-dropdown-button').forEach(function (b) {
              b.addEventListener('click', function () {
                var dropdown = b.closest('.mobile-dropdown');
                var content = dropdown && dropdown.querySelector('.mobile-dropdown-content');
                var icon = b.querySelector('svg');
                var expanded = b.getAttribute('aria-expanded') === 'true';
                b.setAttribute('aria-expanded', String(!expanded));
                if (content) content.classList.toggle('hidden');
                if (icon) icon.classList.toggle('rotate-180');
              });
            });
          })();
        </script>
      `}
    </header>
  );
}

const Chevron = ({ class: cls }: { class: string }) => (
  <svg class={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
  </svg>
);
