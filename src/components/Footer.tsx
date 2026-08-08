import attributionData from '~/data/image-attributions.json';
import { NewsletterForm } from './NewsletterForm';

interface Attribution {
  image: string;
  title: string;
  photographer: string;
  photographerUrl?: string;
  source: string;
  sourceUrl?: string;
  license: string;
}

// The placeholder shipped with the original data file is excluded, so the
// credits block stays hidden until there is a real attribution.
const attributions = (attributionData.attributions as Attribution[]).filter(
  (a) => a.image !== '/images/example.jpg',
);

const quickLinks = [
  { name: 'Current Show', href: '/shows/current' },
  { name: 'Past Shows', href: '/shows/past' },
  { name: 'Members', href: '/members' },
  { name: 'News', href: '/news' },
  { name: 'Contact', href: '/about/contact' },
];

const socialLinks = [
  { name: 'Instagram', href: 'https://instagram.com/fairportdrama', icon: 'instagram' },
  { name: 'Facebook', href: 'https://facebook.com/fairportdrama', icon: 'facebook' },
  { name: 'YouTube', href: 'https://youtube.com/@fairportdrama', icon: 'youtube' },
] as const;

const ICON_PATHS: Record<string, string> = {
  instagram:
    'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z',
  facebook:
    'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z',
  youtube:
    'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
};

export function Footer({ year }: { year: number }) {
  return (
    <footer class="bg-neutral-900 text-neutral-300">
      <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12">
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          <div class="lg:col-span-1">
            <a href="/" class="flex items-center gap-2 mb-4">
              <span class="text-2xl" aria-hidden="true">
                🎭
              </span>
              <span class="font-display font-bold text-xl text-white">Fairport Drama</span>
            </a>
            <p class="text-sm text-neutral-400 mb-4">
              Showcasing student talent through theatrical productions at Fairport High
              School, New York.
            </p>
            <div class="flex gap-4">
              {socialLinks.map((social) => (
                <a
                  href={social.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-neutral-400 hover:text-white transition-colors"
                  aria-label={`Follow us on ${social.name}`}
                >
                  <svg class="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d={ICON_PATHS[social.icon]} />
                  </svg>
                </a>
              ))}
            </div>
          </div>

          <div>
            <h3 class="font-display font-semibold text-white mb-4">Quick Links</h3>
            <ul class="space-y-2">
              {quickLinks.map((link) => (
                <li>
                  <a
                    href={link.href}
                    class="text-sm text-neutral-400 hover:text-white transition-colors"
                  >
                    {link.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 class="font-display font-semibold text-white mb-4">Contact</h3>
            <address class="not-italic text-sm text-neutral-400 space-y-2">
              <p>Fairport High School</p>
              <p>1 Dave Paddock Way</p>
              <p>Fairport, NY 14450</p>
              <p class="pt-2">
                <a
                  href="mailto:hello@fairportdrama.com"
                  class="hover:text-white transition-colors"
                >
                  hello@fairportdrama.com
                </a>
              </p>
            </address>
          </div>

          <div>
            <h3 class="font-display font-semibold text-white mb-4">Stay Updated</h3>
            <p class="text-sm text-neutral-400 mb-4">
              Subscribe to get notified about upcoming shows and auditions.
            </p>
            <NewsletterForm variant="footer" />
          </div>
        </div>

        {attributions.length > 0 && (
          <div class="mt-8 pt-6 border-t border-neutral-800">
            <details class="text-sm">
              <summary class="text-neutral-400 cursor-pointer hover:text-neutral-300 transition-colors">
                Photo Credits
              </summary>
              <ul class="mt-3 space-y-1 text-xs text-neutral-400">
                {attributions.map((attr) => (
                  <li>
                    {attr.title && <span>{attr.title}</span>}
                    {attr.title && ' by '}
                    {attr.photographerUrl ? (
                      <a
                        href={attr.photographerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-neutral-400 hover:text-white transition-colors"
                      >
                        {attr.photographer}
                      </a>
                    ) : (
                      <span>{attr.photographer}</span>
                    )}
                    {' on '}
                    {attr.sourceUrl ? (
                      <a
                        href={attr.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-neutral-400 hover:text-white transition-colors"
                      >
                        {attr.source}
                      </a>
                    ) : (
                      <span>{attr.source}</span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}

        <div class="mt-12 pt-8 border-t border-neutral-800">
          <div class="flex flex-col sm:flex-row justify-between items-center gap-4">
            <p class="text-sm text-neutral-400">
              &copy; {year} Fairport Drama Club Boosters. All rights reserved.
            </p>
            <p class="text-sm text-neutral-400">
              This site is operated by the Fairport Drama Club Boosters, a community
              volunteer organization supporting student theater.
            </p>
            <p class="flex flex-wrap gap-x-4 gap-y-1 text-sm text-neutral-400">
              {[
                { href: '/privacy', label: 'Privacy' },
                { href: '/terms', label: 'Terms' },
                { href: '/disclaimer', label: 'Disclaimer' },
              ].map((link) => (
                <a
                  href={link.href}
                  class="text-neutral-300 hover:text-white transition-colors underline"
                >
                  {link.label}
                </a>
              ))}
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
