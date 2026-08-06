import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '~/env';
import { getDb } from '~/db/queries';
import { subscribe, unsubscribeByToken } from '~/services/newsletter';
import { emailShell, sendEmail } from '~/lib/email';
import { escapeHtml } from '~/lib/html';

export const apiRoutes = new Hono<AppEnv>();

// zod v4: z.email() replaces the deprecated z.string().email().
const subscribeSchema = z.object({
  email: z.email('Please enter a valid email address'),
  name: z.string().max(100).optional(),
  source: z.enum(['website', 'footer', 'popup', 'news', 'hero', 'inline']).default('website'),
});

const contactSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.email('Invalid email address'),
  subject: z.enum(['joining', 'auditions', 'tickets', 'sponsorship', 'volunteer', 'general']),
  message: z.string().min(10, 'Message must be at least 10 characters').max(5000),
  turnstileToken: z.string().min(1, 'Security verification required'),
});

const SUBJECT_LABELS: Record<string, string> = {
  joining: 'Joining Drama Club',
  auditions: 'Audition Information',
  tickets: 'Ticket Questions',
  sponsorship: 'Sponsorship Opportunities',
  volunteer: 'Volunteering',
  general: 'General Inquiry',
};

// ---------------------------------------------------------------- newsletter

apiRoutes.post('/api/newsletter/subscribe', async (c) => {
  const parsed = subscribeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ success: false, error: 'Please enter a valid email address.' }, 400);
  }

  const { email, name, source } = parsed.data;
  const result = await subscribe(getDb(c.env.DB), c.get('actor'), { email, name, source });

  return c.json({ success: true, message: result.message });
});

/**
 * Unsubscribe is a POST, and keyed on a token rather than an email address.
 *
 * The previous version was `GET /api/newsletter/unsubscribe?email=...`, which
 * meant anyone could unsubscribe anyone by guessing an address, and any mail
 * client or security scanner that prefetches links would silently unsubscribe
 * the recipient. The GET below only renders a confirmation page.
 */
apiRoutes.post('/api/newsletter/unsubscribe', async (c) => {
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const token = String((form as Record<string, unknown>).token ?? '');

  await unsubscribeByToken(getDb(c.env.DB), c.get('actor'), token);

  // Reports success either way, so a wrong or spent token cannot be used to
  // probe which tokens are real.
  return c.redirect('/newsletter/unsubscribed', 302);
});

// ---------------------------------------------------------------- contact

interface TurnstileResponse {
  success: boolean;
  'error-codes'?: string[];
}

apiRoutes.post('/api/contact', async (c) => {
  const parsed = contactSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Validation failed', details: z.treeifyError(parsed.error) },
      400,
    );
  }

  const { name, email, subject, message, turnstileToken } = parsed.data;

  const verification = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: c.env.TURNSTILE_SECRET_KEY,
        response: turnstileToken,
        remoteip: c.req.header('CF-Connecting-IP') ?? '',
      }),
    },
  );

  const turnstile = (await verification.json()) as TurnstileResponse;
  if (!turnstile.success) {
    console.error('Turnstile verification failed:', turnstile['error-codes']);
    return c.json(
      { success: false, error: 'Security verification failed. Please try again.' },
      400,
    );
  }

  const label = SUBJECT_LABELS[subject] ?? subject;

  const result = await sendEmail(c.env.EMAIL, {
    to: c.env.CONTACT_EMAIL || 'hello@fairportdrama.com',
    replyTo: { email, name },
    subject: `[Contact Form] ${label}: ${name}`,
    html: emailShell(
      'New Contact Form Submission',
      `<p style="margin:0 0 12px;"><strong>From:</strong> ${escapeHtml(name)} (${escapeHtml(email)})</p>
       <p style="margin:0 0 12px;"><strong>Subject:</strong> ${escapeHtml(label)}</p>
       <p style="margin:0 0 8px;"><strong>Message:</strong></p>
       <p style="margin:0;white-space:pre-wrap;">${escapeHtml(message)}</p>`,
    ),
    text: `New Contact Form Submission\n\nFrom: ${name} (${email})\nSubject: ${label}\n\nMessage:\n${message}`,
  });

  if (!result.ok) {
    console.error('Contact email failed:', result.code, result.message);
    return c.json(
      { success: false, error: 'An unexpected error occurred. Please try again later.' },
      500,
    );
  }

  return c.json({ success: true, message: 'Your message has been sent successfully!' });
});
