import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv } from '~/env';
import { getDb, getSponsors } from '~/db/queries';
import { SponsorGrid, TIER_HEADINGS, TIER_ORDER, type SponsorView } from '~/components/SponsorGrid';

export const aboutRoutes = new Hono<AppEnv>();

const SPONSOR_TIERS = [
  { tier: 'platinum', amount: '$1,000+', perks: ['Full-page playbill ad', 'Logo on the website and all show materials', 'Six tickets to each production'] },
  { tier: 'gold', amount: '$500+', perks: ['Half-page playbill ad', 'Logo on the website', 'Four tickets to each production'] },
  { tier: 'silver', amount: '$250+', perks: ['Quarter-page playbill ad', 'Name on the website', 'Two tickets to each production'] },
  { tier: 'bronze', amount: '$100+', perks: ['Name in the playbill', 'Name on the website'] },
] as const;

aboutRoutes.get('/about/sponsors', async (c) => {
  const images = c.get('images');
  const sponsors = await getSponsors(getDb(c.env.DB));

  return c.render(
    <div class="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-16">
      <h1 class="font-display text-4xl font-bold text-neutral-900 mb-3">Sponsors</h1>
      <p class="text-neutral-600 mb-12 max-w-2xl">
        Our productions are funded almost entirely by community support. Sponsorship pays
        for rights and royalties, sets, costumes, and lighting.
      </p>

      {sponsors.length > 0 && (
        <section class="mb-16">
          <h2 class="font-display text-2xl font-semibold text-neutral-900 mb-8">
            Thank You to Our Supporters
          </h2>
          <SponsorGrid sponsors={sponsors as SponsorView[]} images={images} showTierHeaders />
        </section>
      )}

      <section>
        <h2 class="font-display text-2xl font-semibold text-neutral-900 mb-6">
          Sponsorship Levels
        </h2>
        <div class="grid gap-6 sm:grid-cols-2">
          {SPONSOR_TIERS.map((level) => (
            <div class="bg-white rounded-xl ring-1 ring-neutral-200 p-6">
              <h3 class="font-display text-lg font-semibold text-neutral-900">
                {TIER_HEADINGS[level.tier]}
              </h3>
              <p class="text-primary-600 font-semibold mt-1 mb-4">{level.amount}</p>
              <ul class="space-y-2 text-sm text-neutral-600">
                {level.perks.map((perk) => (
                  <li class="flex gap-2">
                    <span class="text-primary-600" aria-hidden="true">
                      &bull;
                    </span>
                    <span>{perk}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div class="mt-8 text-center">
          <a
            href="/about/contact"
            class="inline-flex items-center justify-center px-8 py-3 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-lg transition-colors"
          >
            Become a Sponsor
          </a>
        </div>
      </section>
    </div>,
    {
      title: 'Sponsors',
      description: 'Sponsor the Fairport High School Drama Club and support student theater.',
    },
  );
});

aboutRoutes.get('/about/boosters', (c) =>
  c.render(
    <div class="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-16 prose prose-neutral">
      <h1 class="font-display text-4xl font-bold text-neutral-900 mb-3">
        Drama Club Boosters
      </h1>
      <p class="text-neutral-600">
        The Fairport Drama Club Boosters is a volunteer parent organization that supports
        student theater at Fairport High School. We fund productions, run concessions,
        build sets, sew costumes, and generally do whatever needs doing so that students
        can focus on making theater.
      </p>

      <h2 class="font-display text-2xl font-semibold text-neutral-900 mt-10 mb-3">
        How to Get Involved
      </h2>
      <ul class="text-neutral-600 space-y-2">
        <li>Volunteer at a performance, backstage or front of house.</li>
        <li>Help build sets or sew costumes in the weeks before a show.</li>
        <li>Sponsor a production, or ask your employer about matching gifts.</li>
        <li>Come to a show and bring someone with you.</li>
      </ul>

      <p class="text-neutral-600 mt-8">
        Questions, or want to help?{' '}
        <a href="/about/contact" class="text-primary-600 hover:text-primary-700">
          Get in touch
        </a>
        .
      </p>
    </div>,
    {
      title: 'Boosters',
      description: 'The volunteer parent organization supporting Fairport High School theater.',
    },
  ),
);

/**
 * The page registered with Google as the application's home page.
 *
 * Google's OAuth review refused verification twice: the home page is behind a
 * login page, and it does not explain the purpose of the app. The site root is
 * public, but it is a page about a drama club's productions - a reviewer
 * landing on it learns nothing about the software or what the OAuth client is
 * for, and burying that under the show listings would serve neither audience.
 *
 * So this exists: public, no sign-in, and about the application rather than
 * about the club. It is what the "Application home page" field should point
 * at. Everything on it has to stay true of the running system - it is a
 * description of behaviour, not marketing copy.
 */
aboutRoutes.get('/about/website', (c) =>
  c.render(
    <div class="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-16">
      <h1 class="font-display text-4xl font-bold text-neutral-900 mb-3">
        About This Website
      </h1>
      <p class="text-lg text-neutral-600 mb-10">
        fairportdrama.com is the website of the Fairport High School Drama Club, in
        Fairport, New York. It is run by the club's own students and volunteers rather
        than by an outside webmaster.
      </p>

      <h2 class="font-display text-2xl font-semibold text-neutral-900 mt-10 mb-3">
        What this application does
      </h2>
      <p class="text-neutral-700 mb-4 leading-relaxed">
        The public part of the site shows the club's productions, cast and crew lists,
        performance dates, news, and member profiles. Anyone can read it without an
        account.
      </p>
      <p class="text-neutral-700 mb-4 leading-relaxed">
        Behind it is a members' area where the club maintains all of that itself. Signed-in
        users can:
      </p>
      <ul class="text-neutral-700 space-y-2 mb-4 list-disc pl-6">
        <li>Create and edit shows, performance dates, and cast and crew lists</li>
        <li>Write news posts and audition notices</li>
        <li>Upload production photographs</li>
        <li>Maintain the member roster and club officer records</li>
        <li>Edit their own member profile, including their photograph and biography</li>
      </ul>
      <p class="text-neutral-700 mb-4 leading-relaxed">
        What each person can do depends on their role. Students who are not club officers
        can only edit their own profile, and their changes are reviewed before they appear
        publicly.
      </p>

      <h2 class="font-display text-2xl font-semibold text-neutral-900 mt-10 mb-3">
        How signing in works
      </h2>
      <p class="text-neutral-700 mb-4 leading-relaxed">
        Members sign in either with a Google account or with a one-time link sent to their
        email address. Google sign-in is offered because most students already have a
        school Google account, and it saves them another password.
      </p>
      <p class="text-neutral-700 mb-4 leading-relaxed">
        <strong>Signing in with Google does not create an account.</strong> Access is by
        invitation only: a member of the Drama Club Boosters board has to invite an email
        address first. Signing in with an address that has not been invited is refused and
        creates no account.
      </p>
      <p class="text-neutral-700 mb-4 leading-relaxed">
        From Google we request only the sign-in scopes - the email address and basic
        profile of the person signing in - and we use them to match the account to its
        invitation. We do not read, send, or store anything else from a Google account.
      </p>

      <h2 class="font-display text-2xl font-semibold text-neutral-900 mt-10 mb-3">
        Students and privacy
      </h2>
      <p class="text-neutral-700 mb-4 leading-relaxed">
        Most members of the club are minors, so every member profile starts private:
        listed as a first name and last initial, with no photograph, no biography, and no
        page of their own. A student chooses for themselves whether to appear in full, and
        can change that back at any time.
      </p>

      <h2 class="font-display text-2xl font-semibold text-neutral-900 mt-10 mb-3">
        Getting access
      </h2>
      <p class="text-neutral-700 mb-6 leading-relaxed">
        If you are a club member, a parent volunteer, or a member of the Boosters board and
        need an account,{' '}
        <a href="/about/contact" class="text-primary-600 hover:text-primary-700">
          get in touch
        </a>{' '}
        and someone on the board will invite you.
      </p>

      <div class="flex flex-wrap gap-4 items-center border-t border-neutral-200 pt-8">
        <a
          href="/admin/sign-in"
          class="inline-flex items-center justify-center px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-lg transition-colors"
        >
          Member sign in
        </a>
        <a href="/" class="text-primary-600 hover:text-primary-700 font-medium">
          Drama Club home
        </a>
        <a href="/privacy" class="text-primary-600 hover:text-primary-700 font-medium">
          Privacy policy
        </a>
        <a href="/terms" class="text-primary-600 hover:text-primary-700 font-medium">
          Terms of use
        </a>
      </div>
    </div>,
    {
      title: 'About This Website',
      description:
        'What the Fairport Drama Club website does, how club members sign in, and how student privacy is handled.',
    },
  ),
);

const SUBJECTS = [
  { value: 'joining', label: 'Joining Drama Club' },
  { value: 'auditions', label: 'Audition Information' },
  { value: 'tickets', label: 'Ticket Questions' },
  { value: 'sponsorship', label: 'Sponsorship Opportunities' },
  { value: 'volunteer', label: 'Volunteering' },
  { value: 'general', label: 'General Inquiry' },
] as const;

aboutRoutes.get('/about/contact', (c) =>
  c.render(
    <div class="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8 py-16">
      <h1 class="font-display text-4xl font-bold text-neutral-900 mb-3">Contact Us</h1>
      <p class="text-neutral-600 mb-10">
        Questions about auditions, tickets, sponsorship, or volunteering? Send us a note.
      </p>

      <form id="contact-form" class="space-y-5">
        <div>
          <label for="contact-name" class="block text-sm font-medium text-neutral-700 mb-1">
            Name
          </label>
          <input
            type="text"
            id="contact-name"
            name="name"
            required
            maxlength={100}
            class="w-full px-4 py-2.5 rounded-lg border border-neutral-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none"
          />
        </div>

        <div>
          <label for="contact-email" class="block text-sm font-medium text-neutral-700 mb-1">
            Email
          </label>
          <input
            type="email"
            id="contact-email"
            name="email"
            required
            autocomplete="email"
            class="w-full px-4 py-2.5 rounded-lg border border-neutral-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none"
          />
        </div>

        <div>
          <label for="contact-subject" class="block text-sm font-medium text-neutral-700 mb-1">
            Subject
          </label>
          <select
            id="contact-subject"
            name="subject"
            required
            class="w-full px-4 py-2.5 rounded-lg border border-neutral-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none bg-white"
          >
            {SUBJECTS.map((s) => (
              <option value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label for="contact-message" class="block text-sm font-medium text-neutral-700 mb-1">
            Message
          </label>
          <textarea
            id="contact-message"
            name="message"
            required
            rows={6}
            minlength={10}
            maxlength={5000}
            class="w-full px-4 py-2.5 rounded-lg border border-neutral-300 focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:outline-none"
          />
        </div>

        {/* Turnstile renders here. The widget script is loaded below; the
            server rejects any submission whose token fails verification. */}
        <div class="cf-turnstile" data-sitekey={c.env.PUBLIC_TURNSTILE_SITE_KEY ?? ''} />

        <button
          type="submit"
          class="w-full px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-lg transition-colors disabled:opacity-50"
        >
          <span class="submit-text">Send Message</span>
          <span class="sending-text hidden">Sending...</span>
        </button>

        <p class="contact-message hidden text-sm" aria-live="polite" />
      </form>

      {html`
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
        <script>
          document.getElementById('contact-form').addEventListener('submit', async function (e) {
            e.preventDefault();
            var form = e.target;
            var button = form.querySelector('button[type="submit"]');
            var submitText = form.querySelector('.submit-text');
            var sendingText = form.querySelector('.sending-text');
            var messageEl = form.querySelector('.contact-message');
            var data = new FormData(form);

            button.disabled = true;
            submitText.classList.add('hidden');
            sendingText.classList.remove('hidden');
            messageEl.classList.add('hidden');

            try {
              var response = await fetch('/api/contact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  name: data.get('name'),
                  email: data.get('email'),
                  subject: data.get('subject'),
                  message: data.get('message'),
                  turnstileToken: data.get('cf-turnstile-response') || '',
                }),
              });
              var body = await response.json();
              if (response.ok) {
                messageEl.textContent = body.message || 'Message sent.';
                messageEl.className = 'contact-message text-sm text-green-600';
                form.reset();
              } else {
                messageEl.textContent = body.error || 'Something went wrong.';
                messageEl.className = 'contact-message text-sm text-red-600';
              }
            } catch (err) {
              messageEl.textContent = 'Unable to connect. Please try again later.';
              messageEl.className = 'contact-message text-sm text-red-600';
            } finally {
              button.disabled = false;
              submitText.classList.remove('hidden');
              sendingText.classList.add('hidden');
              messageEl.classList.remove('hidden');
              if (window.turnstile) window.turnstile.reset();
            }
          });
        </script>
      `}
    </div>,
    { title: 'Contact', description: 'Get in touch with the Fairport Drama Club.' },
  ),
);
