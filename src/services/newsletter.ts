import { and, desc, eq, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import type { DB } from '~/db/queries';
import { newsletterSubscribers } from '~/db/schema/newsletter';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { writeWithAudit } from '~/lib/audit/write';
import type { Actor } from '~/lib/audit/actor';
import { generateId } from '~/lib/id';

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export type SubscribeSource = 'website' | 'footer' | 'popup' | 'news' | 'hero' | 'inline';

export interface SubscribeResult {
  /** What to tell the visitor. Never reveals whether an address was known. */
  message: string;
}

/**
 * Adds an address to the newsletter list.
 *
 * The reply is identical whether the address was new, already subscribed, or
 * previously unsubscribed, so the endpoint cannot be used to test whether
 * somebody is on the list.
 *
 * Audited like any other mutation. The actor is `system` - these are public
 * and unauthenticated - so the IP recorded by the middleware is the only
 * attribution available, which is exactly why it is worth keeping.
 */
export async function subscribe(
  db: DB,
  actor: Actor,
  input: { email: string; name?: string | null; source?: SubscribeSource },
): Promise<SubscribeResult> {
  const email = normalizeEmail(input.email);
  const now = new Date().toISOString();
  const source = input.source ?? 'website';

  const [existing] = await db
    .select()
    .from(newsletterSubscribers)
    .where(eq(newsletterSubscribers.email, email))
    .limit(1);

  if (existing && !existing.unsubscribedAt) {
    return { message: 'Thanks for subscribing!' };
  }

  if (existing) {
    // Resubscribing after opting out is a legitimate action, so it clears the
    // unsubscribe rather than reporting a duplicate. A token is issued here if
    // the row never had one - rows migrated from the Astro site do not.
    await writeWithAudit(
      db,
      actor,
      [
        db
          .update(newsletterSubscribers)
          .set({
            unsubscribedAt: null,
            subscribedAt: now,
            updatedAt: now,
            source,
            confirmationToken: existing.confirmationToken ?? generateId(),
          })
          .where(eq(newsletterSubscribers.email, email)),
      ],
      {
        action: AUDIT_ACTION.NewsletterSubscribed,
        targetKind: AUDIT_ENTITY_KIND.NewsletterSubscriber,
        targetId: email,
        payload: { resubscribed: true, source },
      },
    );
    return { message: 'Thanks for subscribing!' };
  }

  await writeWithAudit(
    db,
    actor,
    [
      db.insert(newsletterSubscribers).values({
        email,
        name: input.name ?? null,
        subscribedAt: now,
        confirmationToken: generateId(),
        source,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    {
      action: AUDIT_ACTION.NewsletterSubscribed,
      targetKind: AUDIT_ENTITY_KIND.NewsletterSubscriber,
      targetId: email,
      payload: { source },
    },
  );

  return { message: 'Thanks for subscribing!' };
}

/** Looks a subscriber up by their unsubscribe token. */
export async function findByToken(db: DB, token: string) {
  if (token.length === 0) return null;
  const [row] = await db
    .select()
    .from(newsletterSubscribers)
    .where(eq(newsletterSubscribers.confirmationToken, token))
    .limit(1);
  return row ?? null;
}

/**
 * Takes an address off the list.
 *
 * Keyed on the token rather than the email address. Keying on the address let
 * anyone unsubscribe anyone by guessing it, and because the old endpoint was a
 * GET, any link scanner or mail client prefetching the URL would unsubscribe
 * the recipient without them clicking anything.
 */
export async function unsubscribeByToken(
  db: DB,
  actor: Actor,
  token: string,
): Promise<{ unsubscribed: boolean; email?: string }> {
  const row = await findByToken(db, token);
  if (!row || row.unsubscribedAt) return { unsubscribed: false };

  const now = new Date().toISOString();

  await writeWithAudit(
    db,
    actor,
    [
      db
        .update(newsletterSubscribers)
        .set({ unsubscribedAt: now, updatedAt: now })
        .where(eq(newsletterSubscribers.id, row.id)),
    ],
    {
      action: AUDIT_ACTION.NewsletterUnsubscribed,
      targetKind: AUDIT_ENTITY_KIND.NewsletterSubscriber,
      targetId: row.email,
      payload: { self: true },
    },
  );

  return { unsubscribed: true, email: row.email };
}

/** Removes an address on request from an admin, rather than by token. */
export async function unsubscribeByEmail(
  db: DB,
  actor: Actor,
  email: string,
): Promise<{ unsubscribed: boolean }> {
  const address = normalizeEmail(email);
  const [row] = await db
    .select()
    .from(newsletterSubscribers)
    .where(eq(newsletterSubscribers.email, address))
    .limit(1);
  if (!row || row.unsubscribedAt) return { unsubscribed: false };

  const now = new Date().toISOString();

  await writeWithAudit(
    db,
    actor,
    [
      db
        .update(newsletterSubscribers)
        .set({ unsubscribedAt: now, updatedAt: now })
        .where(eq(newsletterSubscribers.id, row.id)),
    ],
    {
      action: AUDIT_ACTION.NewsletterUnsubscribed,
      targetKind: AUDIT_ENTITY_KIND.NewsletterSubscriber,
      targetId: address,
      // Distinguishes "they took themselves off" from "a board member did",
      // which is the question a complaint actually asks.
      payload: { self: false },
    },
  );

  return { unsubscribed: true };
}

export interface SubscriberFilter {
  search?: string;
  /** `active` hides anyone who has unsubscribed. */
  status?: 'active' | 'unsubscribed' | 'all';
}

export async function listSubscribers(db: DB, filter: SubscriberFilter = {}) {
  const clauses = [];

  if (filter.status === 'active') clauses.push(isNull(newsletterSubscribers.unsubscribedAt));
  if (filter.status === 'unsubscribed') {
    clauses.push(isNotNull(newsletterSubscribers.unsubscribedAt));
  }

  const search = filter.search?.trim().toLowerCase();
  if (search) {
    clauses.push(
      or(
        like(sql`lower(${newsletterSubscribers.email})`, `%${search}%`),
        like(sql`lower(coalesce(${newsletterSubscribers.name}, ''))`, `%${search}%`),
      ),
    );
  }

  return db
    .select()
    .from(newsletterSubscribers)
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(desc(newsletterSubscribers.subscribedAt))
    .limit(500);
}

export async function countSubscribers(db: DB) {
  const [row] = await db
    .select({
      total: sql<number>`COUNT(*)`,
      active: sql<number>`SUM(CASE WHEN ${newsletterSubscribers.unsubscribedAt} IS NULL THEN 1 ELSE 0 END)`,
    })
    .from(newsletterSubscribers);
  return { total: row?.total ?? 0, active: row?.active ?? 0 };
}

/** RFC 4180 CSV: quotes doubled, fields containing a comma or quote wrapped. */
export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    columns.join(','),
    ...rows.map((r) => columns.map((c) => cell(r[c])).join(',')),
  ].join('\n');
}
