import { eq } from 'drizzle-orm';
import type { DB } from '~/db/queries';
import {
  sponsors,
  spiritWear,
  SPONSOR_TIER,
  SPIRIT_WEAR_CATEGORY,
  type SponsorTier,
  type SpiritWearCategory,
} from '~/db/schema/content';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { buildDiff, isEmptyDiff } from '~/lib/audit/diff';
import { writeWithAudit } from '~/lib/audit/write';
import type { Actor } from '~/lib/audit/actor';
import { generateId } from '~/lib/id';

/**
 * Sponsors and spirit wear.
 *
 * Both change rarely - a handful of times a season - and neither carries
 * anything about a student, so both apply immediately with no approval step.
 * They share this file because they are the same shape of problem: a small
 * catalog with a logo, edited by adults.
 */

// ---------------------------------------------------------------- sponsors

export interface SponsorInput {
  name: string;
  website: string | null;
  tier: SponsorTier;
  logoImageId?: string | null;
  showId: string | null;
  isActive: boolean;
}

export async function createSponsor(
  db: DB,
  actor: Actor,
  input: SponsorInput,
): Promise<{ id: string }> {
  const id = generateId();

  await writeWithAudit(
    db,
    actor,
    [db.insert(sponsors).values({ id, ...input, logoImageId: input.logoImageId ?? null })],
    {
      action: AUDIT_ACTION.SponsorChanged,
      targetKind: AUDIT_ENTITY_KIND.Sponsor,
      targetId: id,
      payload: { created: true, name: input.name, tier: input.tier },
    },
  );

  return { id };
}

export async function updateSponsor(
  db: DB,
  actor: Actor,
  id: string,
  input: Partial<SponsorInput>,
): Promise<{ updated: boolean }> {
  return updateRow(db, actor, {
    table: sponsors,
    id,
    input,
    action: AUDIT_ACTION.SponsorChanged,
    kind: AUDIT_ENTITY_KIND.Sponsor,
  });
}

export async function deleteSponsor(
  db: DB,
  actor: Actor,
  id: string,
): Promise<{ deleted: boolean }> {
  const [current] = await db.select().from(sponsors).where(eq(sponsors.id, id)).limit(1);
  if (!current) return { deleted: false };

  await writeWithAudit(db, actor, [db.delete(sponsors).where(eq(sponsors.id, id))], {
    action: AUDIT_ACTION.SponsorChanged,
    targetKind: AUDIT_ENTITY_KIND.Sponsor,
    targetId: id,
    // Kept on the row because a deleted sponsor cannot be joined against
    // later, and "who removed our platinum sponsor" is a real question.
    payload: { deleted: true, name: current.name, tier: current.tier },
  });

  return { deleted: true };
}

// ------------------------------------------------------------- spirit wear

export interface SpiritWearInput {
  name: string;
  description: string;
  priceCents: number;
  category: SpiritWearCategory;
  sizes: string[];
  colors: string[];
  imageId?: string | null;
  isAvailable: boolean;
  isFeatured: boolean;
}

export async function createSpiritWear(
  db: DB,
  actor: Actor,
  input: SpiritWearInput,
): Promise<{ id: string }> {
  const id = generateId();

  await writeWithAudit(
    db,
    actor,
    [db.insert(spiritWear).values({ id, ...input, imageId: input.imageId ?? null })],
    {
      action: AUDIT_ACTION.SpiritWearChanged,
      targetKind: AUDIT_ENTITY_KIND.SpiritWear,
      targetId: id,
      payload: { created: true, name: input.name, priceCents: input.priceCents },
    },
  );

  return { id };
}

export async function updateSpiritWear(
  db: DB,
  actor: Actor,
  id: string,
  input: Partial<SpiritWearInput>,
): Promise<{ updated: boolean }> {
  return updateRow(db, actor, {
    table: spiritWear,
    id,
    input,
    action: AUDIT_ACTION.SpiritWearChanged,
    kind: AUDIT_ENTITY_KIND.SpiritWear,
  });
}

export async function deleteSpiritWear(
  db: DB,
  actor: Actor,
  id: string,
): Promise<{ deleted: boolean }> {
  const [current] = await db.select().from(spiritWear).where(eq(spiritWear.id, id)).limit(1);
  if (!current) return { deleted: false };

  await writeWithAudit(db, actor, [db.delete(spiritWear).where(eq(spiritWear.id, id))], {
    action: AUDIT_ACTION.SpiritWearChanged,
    targetKind: AUDIT_ENTITY_KIND.SpiritWear,
    targetId: id,
    payload: { deleted: true, name: current.name },
  });

  return { deleted: true };
}

// ------------------------------------------------------------------ shared

/**
 * Update with a field-level diff, for the two tables above.
 *
 * No field is compared here. `buildDiff` already compares structurally, which
 * matters for `sizes` and `colors`: they are JSON columns, so a resubmitted
 * form yields a new array that is never `===` the stored one. An identity
 * check at this layer would be both redundant and wrong.
 */
async function updateRow(
  db: DB,
  actor: Actor,
  opts: {
    table: typeof sponsors | typeof spiritWear;
    id: string;
    input: Record<string, unknown>;
    action: string;
    kind: string;
  },
): Promise<{ updated: boolean }> {
  const { table, id, input } = opts;
  const [current] = await db.select().from(table).where(eq(table.id, id)).limit(1);
  if (!current) return { updated: false };

  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) patch[key] = value;
  }

  const diff = buildDiff(
    current as Record<string, unknown>,
    { ...current, ...patch } as Record<string, unknown>,
    patch,
  );
  // Everything unchanged: no write, no audit row. This is the only guard
  // needed, since the diff is what decides whether anything actually moved.
  if (isEmptyDiff(diff)) return { updated: false };

  await writeWithAudit(
    db,
    actor,
    [
      db
        .update(table)
        .set({ ...patch, updatedAt: new Date().toISOString() })
        .where(eq(table.id, id)),
    ],
    {
      action: opts.action as never,
      targetKind: opts.kind as never,
      targetId: id,
      diff,
    },
  );

  return { updated: true };
}

// ------------------------------------------------------------------ parsing

/** Splits a comma-separated form field into trimmed, non-empty values. */
export function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parses a price entered as dollars into whole cents.
 *
 * Returns null for anything unparseable so the caller can reject the form
 * rather than silently storing 0. Rounding is explicit because
 * `19.99 * 100` is 1998.9999999999998 in floating point.
 */
export function parsePriceCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export const SPONSOR_TIER_LABELS: Record<SponsorTier, string> = {
  [SPONSOR_TIER.Platinum]: 'Platinum',
  [SPONSOR_TIER.Gold]: 'Gold',
  [SPONSOR_TIER.Silver]: 'Silver',
  [SPONSOR_TIER.Bronze]: 'Bronze',
};

export const SPIRIT_WEAR_CATEGORY_LABELS: Record<SpiritWearCategory, string> = {
  [SPIRIT_WEAR_CATEGORY.Apparel]: 'Apparel',
  [SPIRIT_WEAR_CATEGORY.Accessories]: 'Accessories',
  [SPIRIT_WEAR_CATEGORY.Other]: 'Other',
};

export const isSponsorTier = (v: string): v is SponsorTier =>
  Object.values(SPONSOR_TIER).includes(v as SponsorTier);

export const isSpiritWearCategory = (v: string): v is SpiritWearCategory =>
  Object.values(SPIRIT_WEAR_CATEGORY).includes(v as SpiritWearCategory);
