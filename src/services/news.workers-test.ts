import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPublishedNews } from '~/db/queries';
import { news, NEWS_CATEGORY } from '~/db/schema/content';
import { auditEvents } from '~/db/schema/governance';
import { AUDIT_ACTION } from '~/lib/audit/constants';
import { AUDIT_ACTOR_KIND, type Actor } from '~/lib/audit/actor';
import {
  createNewsPost,
  deleteNewsPost,
  slugify,
  uniqueSlug,
  updateNewsPost,
} from './news';

const db = () => getDb(env.DB);

const officer: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'user_officer',
  label: 'Ariana T.',
  ip: '203.0.113.5',
  userAgent: 'test',
};

const post = (over: Partial<Parameters<typeof createNewsPost>[2]> = {}) =>
  createNewsPost(db(), officer, {
    title: 'Spring Auditions Announced',
    excerpt: 'Auditions are next week.',
    bodyMd: 'Come audition.',
    category: NEWS_CATEGORY.Auditions,
    publishedAt: '2026-08-01',
    isDraft: true,
    ...over,
  });

const actions = async () => (await db().select().from(auditEvents)).map((a) => a.action);

beforeEach(async () => {
  await env.DB.exec('DELETE FROM audit_events');
  await env.DB.exec('DELETE FROM news');
});

describe('slugify', () => {
  it('makes a readable url fragment', () => {
    expect(slugify('Spring Auditions Announced')).toBe('spring-auditions-announced');
  });

  it('strips punctuation and collapses separators', () => {
    expect(slugify("Charlotte's Web -- Cast List!")).toBe('charlottes-web-cast-list');
  });

  it('trims leading and trailing separators', () => {
    expect(slugify('  ...Hello...  ')).toBe('hello');
  });

  it('produces an empty string for input with nothing usable', () => {
    expect(slugify('!!!')).toBe('');
  });
});

describe('uniqueSlug', () => {
  it('returns the base when it is free', async () => {
    expect(await uniqueSlug(db(), 'free-slug')).toBe('free-slug');
  });

  it('suffixes when taken, so two posts can share a title', async () => {
    await post();
    expect(await uniqueSlug(db(), 'spring-auditions-announced')).toBe(
      'spring-auditions-announced-2',
    );
  });

  it('falls back to a usable slug when the title yields nothing', async () => {
    expect(await uniqueSlug(db(), '')).toBe('post');
  });
});

describe('creating a post', () => {
  it('starts as a draft and stays off the public site', async () => {
    const { id } = await post();
    expect(id).toBe('spring-auditions-announced');
    expect(await getPublishedNews(db())).toHaveLength(0);
  });

  it('records the author from the session, not from the form', async () => {
    const { id } = await post();
    const [row] = await db().select().from(news).where(eq(news.id, id));
    expect(row!.author).toBe('Ariana T.');
  });

  it('audits the creation', async () => {
    await post();
    expect(await actions()).toContain(AUDIT_ACTION.NewsCreated);
  });
});

describe('publishing', () => {
  it('makes the post visible publicly', async () => {
    const { id } = await post();
    await updateNewsPost(db(), officer, id, { isDraft: false });
    expect(await getPublishedNews(db())).toHaveLength(1);
  });

  // "Who put this live" is a different question from "who changed the wording",
  // and both get asked.
  it('is audited as a distinct action from an edit', async () => {
    const { id } = await post();
    await updateNewsPost(db(), officer, id, { isDraft: false });
    expect(await actions()).toContain(AUDIT_ACTION.NewsPublished);
    expect(await actions()).not.toContain(AUDIT_ACTION.NewsUpdated);
  });

  it('unpublishing is its own action and hides the post again', async () => {
    const { id } = await post({ isDraft: false });
    await updateNewsPost(db(), officer, id, { isDraft: true });
    expect(await getPublishedNews(db())).toHaveLength(0);
    expect(await actions()).toContain(AUDIT_ACTION.NewsUnpublished);
  });

  it('a content edit is audited as an update, not a publish', async () => {
    const { id } = await post();
    await updateNewsPost(db(), officer, id, { title: 'Different Title' });
    expect(await actions()).toContain(AUDIT_ACTION.NewsUpdated);
  });
});

describe('editing', () => {
  // Slugs are the public URL. Regenerating one on edit silently breaks every
  // link anyone has already shared.
  it('never changes the slug when the title changes', async () => {
    const { id } = await post();
    await updateNewsPost(db(), officer, id, { title: 'Completely Different' });

    const rows = await db().select().from(news);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('spring-auditions-announced');
    expect(rows[0]!.title).toBe('Completely Different');
  });

  it('records a field-level diff', async () => {
    const { id } = await post();
    await updateNewsPost(db(), officer, id, { title: 'New Title' });

    const [row] = (await db().select().from(auditEvents)).filter(
      (a) => a.action === AUDIT_ACTION.NewsUpdated,
    );
    expect(row!.diff).toEqual({
      title: { before: 'Spring Auditions Announced', after: 'New Title' },
    });
  });

  it('writes nothing when nothing changed', async () => {
    const { id } = await post();
    await env.DB.exec('DELETE FROM audit_events');

    const result = await updateNewsPost(db(), officer, id, {
      title: 'Spring Auditions Announced',
    });
    expect(result.updated).toBe(false);
    expect(await actions()).toEqual([]);
  });

  it('ignores an unknown post', async () => {
    expect((await updateNewsPost(db(), officer, 'nope', { title: 'x' })).updated).toBe(
      false,
    );
  });
});

describe('deleting', () => {
  it('removes the post', async () => {
    const { id } = await post();
    expect((await deleteNewsPost(db(), officer, id)).deleted).toBe(true);
    expect(await db().select().from(news)).toHaveLength(0);
  });

  // A deleted row cannot be joined against later, so the log has to carry
  // enough to say what was removed.
  it('records the title, since the row is gone', async () => {
    const { id } = await post();
    await deleteNewsPost(db(), officer, id);

    const [row] = (await db().select().from(auditEvents)).filter(
      (a) => a.action === AUDIT_ACTION.NewsDeleted,
    );
    expect((row!.payload as Record<string, unknown>).title).toBe(
      'Spring Auditions Announced',
    );
  });

  it('ignores an unknown post', async () => {
    expect((await deleteNewsPost(db(), officer, 'nope')).deleted).toBe(false);
  });
});
