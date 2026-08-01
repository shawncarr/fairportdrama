import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import { sponsors, spiritWear, SPONSOR_TIER, SPIRIT_WEAR_CATEGORY } from '~/db/schema/content';
import { auditEvents } from '~/db/schema/governance';
import { AUDIT_ACTOR_KIND, type Actor } from '~/lib/audit/actor';
import { AUDIT_ACTION } from '~/lib/audit/constants';
import {
  createSponsor,
  createSpiritWear,
  deleteSponsor,
  deleteSpiritWear,
  updateSponsor,
  updateSpiritWear,
} from './catalog';

const db = () => getDb(env.DB);

const board: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'user_board',
  label: 'Board Member',
  ip: '203.0.113.30',
  userAgent: 'Firefox',
};

const audits = async () => db().select().from(auditEvents);

const newSponsor = {
  name: 'Fairport Hardware',
  website: 'https://example.com',
  tier: SPONSOR_TIER.Gold,
  showId: null,
  isActive: true,
};

const newItem = {
  name: 'Drama Club Hoodie',
  description: 'Heavyweight, navy.',
  priceCents: 3500,
  category: SPIRIT_WEAR_CATEGORY.Apparel,
  sizes: ['S', 'M', 'L'],
  colors: ['Navy'],
  isAvailable: true,
  isFeatured: false,
};

beforeEach(async () => {
  await env.DB.exec('DELETE FROM audit_events');
  await env.DB.exec('DELETE FROM sponsors');
  await env.DB.exec('DELETE FROM spirit_wear');
});

describe('sponsors', () => {
  it('creates with an audit row naming what was added', async () => {
    const { id } = await createSponsor(db(), board, newSponsor);

    const [row] = await db().select().from(sponsors).where(eq(sponsors.id, id));
    expect(row!.name).toBe('Fairport Hardware');
    expect(row!.tier).toBe(SPONSOR_TIER.Gold);

    const [audit] = await audits();
    expect(audit!.action).toBe(AUDIT_ACTION.SponsorChanged);
    expect(audit!.payload).toMatchObject({ created: true, name: 'Fairport Hardware' });
  });

  it('records a field-level diff on update', async () => {
    const { id } = await createSponsor(db(), board, newSponsor);
    await env.DB.exec('DELETE FROM audit_events');

    const result = await updateSponsor(db(), board, id, { tier: SPONSOR_TIER.Platinum });
    expect(result.updated).toBe(true);

    const [audit] = await audits();
    expect(audit!.diff).toEqual({
      tier: { before: SPONSOR_TIER.Gold, after: SPONSOR_TIER.Platinum },
    });
  });

  it('writes nothing when a resubmitted form changes nothing', async () => {
    const { id } = await createSponsor(db(), board, newSponsor);
    await env.DB.exec('DELETE FROM audit_events');

    const result = await updateSponsor(db(), board, id, newSponsor);
    expect(result.updated).toBe(false);
    expect(await audits()).toHaveLength(0);
  });

  it('keeps the name on the audit row when deleted', async () => {
    const { id } = await createSponsor(db(), board, newSponsor);
    await env.DB.exec('DELETE FROM audit_events');

    expect((await deleteSponsor(db(), board, id)).deleted).toBe(true);
    expect(await db().select().from(sponsors)).toHaveLength(0);

    // A deleted row cannot be joined against later, so "who removed our
    // platinum sponsor" is only answerable if the name is on the row.
    const [audit] = await audits();
    expect(audit!.payload).toMatchObject({ deleted: true, name: 'Fairport Hardware' });
  });

  it('ignores an unknown id rather than throwing', async () => {
    expect((await updateSponsor(db(), board, 'nope', { name: 'x' })).updated).toBe(false);
    expect((await deleteSponsor(db(), board, 'nope')).deleted).toBe(false);
  });
});

describe('spirit wear', () => {
  it('round-trips the JSON list columns', async () => {
    const { id } = await createSpiritWear(db(), board, newItem);

    const [row] = await db().select().from(spiritWear).where(eq(spiritWear.id, id));
    expect(row!.sizes).toEqual(['S', 'M', 'L']);
    expect(row!.colors).toEqual(['Navy']);
    expect(row!.priceCents).toBe(3500);
  });

  it('does not record a change when the same sizes are resubmitted', async () => {
    const { id } = await createSpiritWear(db(), board, newItem);
    await env.DB.exec('DELETE FROM audit_events');

    // sizes is a JSON column, so a resubmitted form yields a new array that is
    // never === the stored one. Comparing by identity would log a change on
    // every single save.
    const result = await updateSpiritWear(db(), board, id, { sizes: ['S', 'M', 'L'] });
    expect(result.updated).toBe(false);
    expect(await audits()).toHaveLength(0);
  });

  it('does record a change when the sizes actually differ', async () => {
    const { id } = await createSpiritWear(db(), board, newItem);
    await env.DB.exec('DELETE FROM audit_events');

    expect((await updateSpiritWear(db(), board, id, { sizes: ['S', 'M'] })).updated).toBe(true);

    const [row] = await db().select().from(spiritWear).where(eq(spiritWear.id, id));
    expect(row!.sizes).toEqual(['S', 'M']);
  });

  it('treats a reordered list as a change, since display order follows it', async () => {
    const { id } = await createSpiritWear(db(), board, newItem);
    await env.DB.exec('DELETE FROM audit_events');

    expect(
      (await updateSpiritWear(db(), board, id, { sizes: ['L', 'M', 'S'] })).updated,
    ).toBe(true);
  });

  it('audits a price change with both values', async () => {
    const { id } = await createSpiritWear(db(), board, newItem);
    await env.DB.exec('DELETE FROM audit_events');

    await updateSpiritWear(db(), board, id, { priceCents: 4000 });

    const [audit] = await audits();
    expect(audit!.action).toBe(AUDIT_ACTION.SpiritWearChanged);
    expect(audit!.diff).toEqual({ priceCents: { before: 3500, after: 4000 } });
  });

  it('deletes and keeps the name', async () => {
    const { id } = await createSpiritWear(db(), board, newItem);
    await env.DB.exec('DELETE FROM audit_events');

    expect((await deleteSpiritWear(db(), board, id)).deleted).toBe(true);
    const [audit] = await audits();
    expect(audit!.payload).toMatchObject({ deleted: true, name: 'Drama Club Hoodie' });
  });
});
