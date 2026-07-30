import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * Pre-existing table, carried over verbatim from the Astro site.
 *
 * This holds live production subscribers. It is declared here exactly as it
 * exists in the database so migrations treat it as already-present and never
 * attempt to recreate or alter it.
 */
export const newsletterSubscribers = sqliteTable(
  'newsletter_subscribers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: text('email').notNull().unique(),
    name: text('name'),
    subscribedAt: text('subscribed_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    confirmedAt: text('confirmed_at'),
    confirmationToken: text('confirmation_token'),
    unsubscribedAt: text('unsubscribed_at'),
    source: text('source').default('website'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    index('idx_subscribers_email').on(t.email),
    index('idx_subscribers_confirmed').on(t.confirmedAt),
    index('idx_subscribers_active').on(t.unsubscribedAt),
  ],
);

export type NewsletterSubscriber = typeof newsletterSubscribers.$inferSelect;
export type NewNewsletterSubscriber = typeof newsletterSubscribers.$inferInsert;
