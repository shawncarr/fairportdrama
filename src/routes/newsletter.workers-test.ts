import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import app from '~/index';
import { getDb } from '~/db/queries';
import { newsletterSubscribers } from '~/db/schema/newsletter';
import { auditEvents, APP_ROLE } from '~/db/schema/governance';
import { get, post, resetTables, signIn } from '~/test/session';

const db = () => getDb(env.DB);
const rows = () => db().select().from(newsletterSubscribers);
const find = async (email: string) =>
  (await db().select().from(newsletterSubscribers).where(eq(newsletterSubscribers.email, email)))[0];

const subscribeVia = (body: unknown) =>
  app.fetch(
    new Request('https://fairportdrama.com/api/newsletter/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
      body: JSON.stringify(body),
    }),
    env,
  );

beforeEach(async () => {
  await resetTables(['members']);
  await env.DB.exec('DELETE FROM newsletter_subscribers');
});

describe('subscribing through the API', () => {
  it('stores the address', async () => {
    const res = await subscribeVia({ email: 'a@example.com', source: 'footer' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
    expect(await rows()).toHaveLength(1);
  });

  it('records the visitor IP on the audit row', async () => {
    await subscribeVia({ email: 'a@example.com' });
    const [audit] = await db().select().from(auditEvents);
    expect(audit!.ip).toBe('198.51.100.7');
  });

  it('rejects a malformed address without writing', async () => {
    const res = await subscribeVia({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it('rejects a body that is not JSON', async () => {
    const res = await app.fetch(
      new Request('https://fairportdrama.com/api/newsletter/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe('unsubscribing', () => {
  const setup = async () => {
    await subscribeVia({ email: 'a@example.com' });
    return (await find('a@example.com'))!.confirmationToken!;
  };

  it('no longer exposes a GET that mutates', async () => {
    await setup();
    // The old endpoint let anyone remove anyone by guessing an address, and
    // link prefetchers fired it without a human clicking.
    const res = await get('/api/newsletter/unsubscribe?email=a@example.com');
    expect(res.status).toBe(404);
    expect((await find('a@example.com'))!.unsubscribedAt).toBeNull();
  });

  it('shows a confirmation page without changing anything', async () => {
    const token = await setup();
    const res = await get(`/newsletter/unsubscribe?token=${token}`);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('a@example.com');
    expect((await find('a@example.com'))!.unsubscribedAt).toBeNull();
  });

  it('unsubscribes on POST and confirms', async () => {
    const token = await setup();
    const form = new FormData();
    form.set('token', token);

    const res = await app.fetch(
      new Request('https://fairportdrama.com/api/newsletter/unsubscribe', {
        method: 'POST',
        body: form,
        redirect: 'manual',
      }),
      env,
    );
    expect(res.headers.get('location')).toBe('/newsletter/unsubscribed');
    expect((await find('a@example.com'))!.unsubscribedAt).toBeTruthy();
  });

  it('404s a spent or unknown token rather than saying which', async () => {
    await setup();
    expect((await get('/newsletter/unsubscribe?token=nope')).status).toBe(404);
    expect((await get('/newsletter/unsubscribe')).status).toBe(404);
  });
});

describe('the newsletter admin page', () => {
  it('lists subscribers for an admin', async () => {
    await subscribeVia({ email: 'a@example.com' });
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const body = await (await get('/admin/newsletter', cookie)).text();
    expect(body).toContain('a@example.com');
    expect(body).toContain('does not send newsletters');
  });

  it('is refused to staff, since it is personal data of the public', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);
    expect((await get('/admin/newsletter', cookie)).status).toBe(403);
  });

  it('unsubscribes someone on request, recorded as not self-service', async () => {
    await subscribeVia({ email: 'a@example.com' });
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    await env.DB.exec('DELETE FROM audit_events');

    const form = new FormData();
    form.set('email', 'a@example.com');
    await post('/admin/newsletter/unsubscribe', cookie, form);

    expect((await find('a@example.com'))!.unsubscribedAt).toBeTruthy();
    const [audit] = await db().select().from(auditEvents);
    expect(audit!.payload).toMatchObject({ self: false });
  });

  it('exports CSV with a filename and no-store', async () => {
    await subscribeVia({ email: 'a@example.com', name: 'Anna' });
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);

    const res = await get('/admin/newsletter/export?status=active', cookie);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('newsletter-active.csv');
    expect(res.headers.get('cache-control')).toContain('no-store');

    const csv = await res.text();
    expect(csv.split('\n')[0]).toBe('email,name,subscribed_at,unsubscribed_at,source');
    expect(csv).toContain('a@example.com,Anna');
  });

  it('does not export to staff', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);
    expect((await get('/admin/newsletter/export', cookie)).status).toBe(403);
  });
});
