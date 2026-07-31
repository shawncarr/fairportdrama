import { eq } from 'drizzle-orm';
import type { DB } from '~/db/queries';
import { news, NEWS_CATEGORY, type NewsCategory } from '~/db/schema/content';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { buildDiff, isEmptyDiff } from '~/lib/audit/diff';
import { writeWithAudit } from '~/lib/audit/write';
import type { Actor } from '~/lib/audit/actor';

export interface NewsInput {
  title: string;
  excerpt: string;
  bodyMd: string;
  category: NewsCategory;
  publishedAt: string;
  isDraft: boolean;
}

/**
 * Turns a title into a URL slug.
 *
 * Slugs are the primary key and appear in the public URL, so they are
 * generated once at creation and never regenerated on edit - changing a slug
 * silently breaks every link anyone has already shared.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Apostrophes are dropped rather than treated as separators, so
    // "Charlotte's Web" becomes charlottes-web and not charlotte-s-web.
    .replace(/['\u2018\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Appends a numeric suffix until the slug is free. */
export async function uniqueSlug(db: DB, base: string): Promise<string> {
  const root = base.length > 0 ? base : 'post';
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? root : `${root}-${n + 1}`;
    const existing = await db
      .select({ id: news.id })
      .from(news)
      .where(eq(news.id, candidate))
      .limit(1);
    if (existing.length === 0) return candidate;
  }
  throw new Error('Could not find a free slug');
}

export async function createNewsPost(
  db: DB,
  actor: Actor,
  input: NewsInput,
): Promise<{ id: string }> {
  const id = await uniqueSlug(db, slugify(input.title));

  await writeWithAudit(
    db,
    actor,
    [
      db.insert(news).values({
        id,
        title: input.title,
        excerpt: input.excerpt,
        bodyMd: input.bodyMd,
        category: input.category,
        publishedAt: input.publishedAt,
        author: actor.label,
        isDraft: input.isDraft,
      }),
    ],
    {
      action: AUDIT_ACTION.NewsCreated,
      targetKind: AUDIT_ENTITY_KIND.News,
      targetId: id,
      payload: { title: input.title, isDraft: input.isDraft },
    },
  );

  return { id };
}

export async function updateNewsPost(
  db: DB,
  actor: Actor,
  id: string,
  input: Partial<NewsInput>,
): Promise<{ updated: boolean }> {
  const [current] = await db.select().from(news).where(eq(news.id, id)).limit(1);
  if (!current) return { updated: false };

  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && (current as Record<string, unknown>)[key] !== value) {
      patch[key] = value;
    }
  }
  if (Object.keys(patch).length === 0) return { updated: false };

  const after = { ...current, ...patch };
  const diff = buildDiff(
    current as Record<string, unknown>,
    after as Record<string, unknown>,
    patch,
  );
  if (isEmptyDiff(diff)) return { updated: false };

  // Publishing is a distinct event from editing: "who put this live" is a
  // different question from "who changed the wording", and both get asked.
  const publishing = 'isDraft' in patch && patch.isDraft === false;
  const unpublishing = 'isDraft' in patch && patch.isDraft === true;

  await writeWithAudit(
    db,
    actor,
    [
      db
        .update(news)
        .set({ ...patch, updatedAt: new Date().toISOString() })
        .where(eq(news.id, id)),
    ],
    {
      action: publishing
        ? AUDIT_ACTION.NewsPublished
        : unpublishing
          ? AUDIT_ACTION.NewsUnpublished
          : AUDIT_ACTION.NewsUpdated,
      targetKind: AUDIT_ENTITY_KIND.News,
      targetId: id,
      diff,
    },
  );

  return { updated: true };
}

export async function deleteNewsPost(
  db: DB,
  actor: Actor,
  id: string,
): Promise<{ deleted: boolean }> {
  const [current] = await db.select().from(news).where(eq(news.id, id)).limit(1);
  if (!current) return { deleted: false };

  await writeWithAudit(
    db,
    actor,
    [db.delete(news).where(eq(news.id, id))],
    {
      action: AUDIT_ACTION.NewsDeleted,
      targetKind: AUDIT_ENTITY_KIND.News,
      targetId: id,
      // The title is kept so the log says what was removed. A deleted row
      // cannot be joined against later.
      payload: { title: current.title, wasDraft: current.isDraft },
    },
  );

  return { deleted: true };
}

export const NEWS_CATEGORY_LABELS: Record<NewsCategory, string> = {
  [NEWS_CATEGORY.Auditions]: 'Auditions',
  [NEWS_CATEGORY.ShowUpdates]: 'Show Updates',
  [NEWS_CATEGORY.Achievements]: 'Achievements',
  [NEWS_CATEGORY.Events]: 'Events',
  [NEWS_CATEGORY.General]: 'General News',
};

export const isNewsCategory = (v: string): v is NewsCategory =>
  Object.values(NEWS_CATEGORY).includes(v as NewsCategory);
