import { html } from 'hono/html';

type Variant = 'footer' | 'inline' | 'hero';

const inputClasses: Record<Variant, string> = {
  footer:
    'bg-neutral-800 border-neutral-700 text-white placeholder-neutral-500 focus:border-primary-500 focus:ring-primary-500',
  inline:
    'bg-white border-neutral-300 text-neutral-900 placeholder-neutral-500 focus:border-primary-500 focus:ring-primary-500',
  hero: 'bg-white/10 border-white/20 text-white placeholder-white/60 focus:border-white focus:ring-white',
};

const buttonClasses: Record<Variant, string> = {
  footer: 'bg-primary-600 hover:bg-primary-700 text-white',
  inline: 'bg-primary-600 hover:bg-primary-700 text-white',
  hero: 'bg-white text-primary-600 hover:bg-white/90',
};

export function NewsletterForm({ variant = 'inline' }: { variant?: Variant }) {
  return (
    <form
      class="newsletter-form"
      data-variant={variant}
      data-source={variant}
      action="/api/newsletter/subscribe"
      method="post"
    >
      <div class="flex flex-col sm:flex-row gap-2">
        <div class="flex-1">
          <label for={`newsletter-email-${variant}`} class="sr-only">
            Email address
          </label>
          <input
            type="email"
            id={`newsletter-email-${variant}`}
            name="email"
            required
            autocomplete="email"
            placeholder="Enter your email"
            class={`w-full px-4 py-2.5 text-sm rounded-lg border transition-colors focus:outline-none focus:ring-2 ${inputClasses[variant]}`}
          />
        </div>
        <button
          type="submit"
          class={`px-6 py-2.5 text-sm font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${buttonClasses[variant]} disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          <span class="subscribe-text">Subscribe</span>
          <span class="loading-text hidden">
            <svg class="animate-spin h-4 w-4 inline-block" fill="none" viewBox="0 0 24 24">
              <circle
                class="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                stroke-width="4"
              />
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          </span>
        </button>
      </div>
      <p class="form-message mt-2 text-sm hidden" aria-live="polite" />
    </form>
  );
}

/**
 * Rendered once per page rather than per form, since a page can contain more
 * than one newsletter form (footer plus an inline one) and the handler binds to
 * all of them.
 */
export const newsletterScript = () => html`
  <script>
    document.querySelectorAll('.newsletter-form').forEach(function (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var button = form.querySelector('button[type="submit"]');
        var subscribeText = form.querySelector('.subscribe-text');
        var loadingText = form.querySelector('.loading-text');
        var messageEl = form.querySelector('.form-message');
        var emailInput = form.querySelector('input[type="email"]');

        button.disabled = true;
        subscribeText.classList.add('hidden');
        loadingText.classList.remove('hidden');
        messageEl.classList.add('hidden');

        try {
          var response = await fetch('/api/newsletter/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: new FormData(form).get('email'),
              source: form.getAttribute('data-source') || 'website',
            }),
          });
          var data = await response.json();
          if (response.ok) {
            messageEl.textContent =
              data.message || 'Thanks for subscribing! Check your email to confirm.';
            messageEl.className = 'form-message mt-2 text-sm text-green-500';
            emailInput.value = '';
          } else {
            messageEl.textContent = data.error || 'Something went wrong. Please try again.';
            messageEl.className = 'form-message mt-2 text-sm text-red-500';
          }
        } catch (err) {
          messageEl.textContent = 'Unable to connect. Please try again later.';
          messageEl.className = 'form-message mt-2 text-sm text-red-500';
        } finally {
          button.disabled = false;
          subscribeText.classList.remove('hidden');
          loadingText.classList.add('hidden');
          messageEl.classList.remove('hidden');
        }
      });
    });
  </script>
`;
