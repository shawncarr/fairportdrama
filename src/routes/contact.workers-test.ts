import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '~/index';
import { resetTables } from '~/test/session';

/**
 * The contact form: validation, Turnstile, and the email it sends.
 *
 * Turnstile is reached with a bare `fetch`, so it is stubbed rather than
 * called - a test that hits Cloudflare's real endpoint is slow, needs network,
 * and cannot exercise the rejection path deterministically.
 *
 * The EMAIL binding is passed in explicitly. Spying on `env.EMAIL.send`
 * silently records nothing, because reading `env.EMAIL` yields a different
 * object depending on when it is read.
 */

interface Sent {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: { email: string; name?: string };
}

const fakeEmail = (ok = true) => {
  const sent: Sent[] = [];
  const binding = {
    send: async (message: Sent) => {
      sent.push(message);
      if (!ok) throw new Error('delivery failed');
      // sendEmail reads messageId off the result; returning nothing would be
      // caught as a delivery failure rather than a success.
      return { messageId: 'test-message-id' };
    },
  } as unknown as SendEmail;
  return { binding, sent };
};

/** `env` is not spreadable, so the bindings the route reads are listed. */
const envWith = (email: SendEmail) =>
  ({
    DB: env.DB,
    KV: env.KV,
    IMAGES: env.IMAGES,
    EMAIL: email,
    APP_ENV: 'development',
    SITE_URL: 'http://localhost:8787',
    CONTACT_EMAIL: 'board@fairportdrama.com',
    TURNSTILE_SECRET_KEY: 'secret',
    CF_IMAGES_ACCOUNT_HASH: 'PLACEHOLDER_IMAGES_ACCOUNT_HASH',
  }) as never;

const stubTurnstile = (success: boolean) =>
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    if (String(input).includes('turnstile')) {
      return new Response(JSON.stringify({ success, 'error-codes': success ? [] : ['invalid'] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  });

const submit = (body: unknown, email: SendEmail) =>
  app.fetch(
    new Request('https://fairportdrama.com/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.9' },
      body: JSON.stringify(body),
    }),
    envWith(email),
  );

const valid = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  subject: 'auditions',
  message: 'When are auditions for the spring show?',
  turnstileToken: 'tok',
};

beforeEach(async () => {
  await resetTables([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validation', () => {
  beforeEach(() => stubTurnstile(true));

  it('rejects each missing or malformed field without sending', async () => {
    const cases = [
      { ...valid, name: '' },
      { ...valid, email: 'not-an-email' },
      { ...valid, subject: 'nonsense' },
      { ...valid, message: 'too short' },
      { ...valid, turnstileToken: '' },
      {},
    ];

    for (const payload of cases) {
      const mail = fakeEmail();
      const res = await submit(payload, mail.binding);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      expect(mail.sent).toHaveLength(0);
    }
  });

  it('rejects a body that is not JSON', async () => {
    const mail = fakeEmail();
    const res = await app.fetch(
      new Request('https://fairportdrama.com/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
      envWith(mail.binding),
    );
    expect(res.status).toBe(400);
    expect(mail.sent).toHaveLength(0);
  });

  it('rejects a message over the length limit', async () => {
    const mail = fakeEmail();
    const res = await submit({ ...valid, message: 'x'.repeat(5001) }, mail.binding);
    expect(res.status).toBe(400);
    expect(mail.sent).toHaveLength(0);
  });
});

describe('Turnstile', () => {
  it('refuses to send when verification fails', async () => {
    stubTurnstile(false);
    const mail = fakeEmail();

    const res = await submit(valid, mail.binding);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false });
    // The point of the check: no mail leaves on a failed challenge.
    expect(mail.sent).toHaveLength(0);
  });

  it('passes the secret and the visitor IP to the verify endpoint', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await submit(valid, fakeEmail().binding);
    expect(seen[0]).toContain('secret=secret');
    expect(seen[0]).toContain('response=tok');
    expect(seen[0]).toContain('remoteip=198.51.100.9');
  });
});

describe('the email it sends', () => {
  beforeEach(() => stubTurnstile(true));

  it('goes to the configured address with the sender as reply-to', async () => {
    const mail = fakeEmail();
    const res = await submit(valid, mail.binding);

    expect(res.status).toBe(200);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe('board@fairportdrama.com');
    expect(mail.sent[0]!.replyTo).toMatchObject({ email: 'ada@example.com' });
    expect(mail.sent[0]!.subject).toContain('Audition Information');
    expect(mail.sent[0]!.subject).toContain('Ada Lovelace');
  });

  it('carries the message in both the HTML and plain text parts', async () => {
    const mail = fakeEmail();
    await submit(valid, mail.binding);

    expect(mail.sent[0]!.html).toContain('When are auditions');
    expect(mail.sent[0]!.text).toContain('When are auditions');
  });

  it('escapes the sender name and message, which are attacker-controlled', async () => {
    const mail = fakeEmail();
    await submit(
      {
        ...valid,
        name: '<script>alert(1)</script>',
        message: 'Hello <img src=x onerror=alert(1)> and & friends',
      },
      mail.binding,
    );

    const html = mail.sent[0]!.html;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('reports failure without claiming the message was sent', async () => {
    const mail = fakeEmail(false);
    const res = await submit(valid, mail.binding);

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false });
  });
});
