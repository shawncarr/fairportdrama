import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import { shows } from '~/db/schema/content';
import { auditEvents } from '~/db/schema/governance';
import { AUDIT_ACTOR_KIND, type Actor } from '~/lib/audit/actor';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { updateShowImages } from './show-images';

const db = () => getDb(env.DB);

const staff: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'user_staff',
  label: 'Director',
  ip: '203.0.113.20',
  userAgent: 'Firefox',
};

const seedShow = async (over: Partial<typeof shows.$inferInsert> = {}) => {
  await db().insert(shows).values({
    id: 'charlottes-web',
    title: "Charlotte's Web",
    season: 'Fall 2025',
    year: 2025,
    synopsis: 'A pig and a spider.',
    ...over,
  });
};

const show = async () =>
  (await db().select().from(shows).where(eq(shows.id, 'charlottes-web')))[0]!;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM audit_events');
  await env.DB.exec('DELETE FROM shows');
});

describe('updateShowImages', () => {
  it('sets an image and records the change', async () => {
    await seedShow();

    const result = await updateShowImages(db(), staff, 'charlottes-web', {
      posterImageId: 'img-poster',
    });

    expect(result.changed).toBe(true);
    expect((await show()).posterImageId).toBe('img-poster');

    const [audit] = await db().select().from(auditEvents);
    expect(audit!.action).toBe(AUDIT_ACTION.ShowUpdated);
    expect(audit!.targetKind).toBe(AUDIT_ENTITY_KIND.Show);
    expect(audit!.diff).toEqual({
      posterImageId: { before: null, after: 'img-poster' },
    });
  });

  it('leaves untouched slots alone', async () => {
    await seedShow({ posterImageId: 'img-poster', heroImageId: 'img-hero' });

    // An unchosen file input yields no patch entry at all. That has to mean
    // "keep it", not "clear it" - otherwise saving one slot wipes the others.
    await updateShowImages(db(), staff, 'charlottes-web', { heroImageId: 'img-hero-2' });

    const row = await show();
    expect(row.posterImageId).toBe('img-poster');
    expect(row.heroImageId).toBe('img-hero-2');
  });

  it('writes nothing when the id is unchanged', async () => {
    await seedShow({ posterImageId: 'img-poster' });

    const result = await updateShowImages(db(), staff, 'charlottes-web', {
      posterImageId: 'img-poster',
    });

    expect(result.changed).toBe(false);
    expect(await db().select().from(auditEvents)).toHaveLength(0);
  });

  it('records all three slots in one audit row', async () => {
    await seedShow();

    await updateShowImages(db(), staff, 'charlottes-web', {
      posterImageId: 'img-p',
      heroImageId: 'img-h',
      ogImageId: 'img-o',
    });

    const rows = await db().select().from(auditEvents);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!.diff as object).sort()).toEqual([
      'heroImageId',
      'ogImageId',
      'posterImageId',
    ]);
  });

  it('rejects an unknown show rather than silently doing nothing', async () => {
    await expect(
      updateShowImages(db(), staff, 'no-such-show', { posterImageId: 'x' }),
    ).rejects.toThrow('Unknown show');
  });
});
