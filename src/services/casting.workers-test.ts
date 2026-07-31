import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { getCast, getDb } from '~/db/queries';
import { members, showCast, shows } from '~/db/schema/content';
import { auditEvents } from '~/db/schema/governance';
import { AUDIT_ACTION } from '~/lib/audit/constants';
import { AUDIT_ACTOR_KIND, type Actor } from '~/lib/audit/actor';
import { castDiff, replaceCast, replaceCrew } from './casting';

const db = () => getDb(env.DB);

const officer: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'user_officer',
  label: 'Officer',
  ip: null,
  userAgent: null,
};

const cast = (role: string, memberId: string | null, tier = 'ensemble') => ({
  role,
  memberId,
  tier: tier as 'lead' | 'supporting' | 'ensemble',
  additionalRoles: [] as string[],
});

const stored = async () =>
  db().select().from(showCast).where(eq(showCast.showId, 'test-show')).orderBy(asc(showCast.sortOrder));

const auditRows = async () => db().select().from(auditEvents);

beforeEach(async () => {
  await env.DB.exec('DELETE FROM audit_events');
  await env.DB.exec('DELETE FROM show_cast');
  await env.DB.exec('DELETE FROM show_crew');
  await env.DB.exec('DELETE FROM shows');
  await env.DB.exec('DELETE FROM members');

  await db().insert(members).values([
    { id: 'daniel', name: 'Daniel Doser', grade: 'Senior' },
    { id: 'marleigh', name: 'Marleigh Priest', grade: 'Junior' },
  ]);
  await db().insert(shows).values({
    id: 'test-show',
    title: 'Test Show',
    season: 'Spring 2026',
    year: 2026,
    synopsis: 'x',
  });
});

describe('assigning cast', () => {
  it('stores roles in the submitted order', async () => {
    await replaceCast(db(), officer, 'test-show', [
      cast('Percy', 'daniel', 'lead'),
      cast('Annabeth', 'marleigh', 'lead'),
    ]);

    const rows = await stored();
    expect(rows.map((r) => r.role)).toEqual(['Percy', 'Annabeth']);
    expect(rows.map((r) => r.sortOrder)).toEqual([0, 1]);
  });

  // A part with nobody cast still belongs on the site: it tells the audience
  // the role exists.
  it('keeps an uncast role as TBA rather than dropping it', async () => {
    await replaceCast(db(), officer, 'test-show', [cast('Uncast Role', null)]);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.memberId).toBeNull();
  });

  it('drops rows whose role name is blank, so empty form rows vanish', async () => {
    await replaceCast(db(), officer, 'test-show', [
      cast('Percy', 'daniel'),
      cast('   ', null),
      cast('', null),
    ]);
    expect(await stored()).toHaveLength(1);
  });

  it('trims whitespace from role names', async () => {
    await replaceCast(db(), officer, 'test-show', [cast('  Percy  ', 'daniel')]);
    expect((await stored())[0]!.role).toBe('Percy');
  });

  it('ignores an unknown show', async () => {
    expect((await replaceCast(db(), officer, 'nope', [cast('X', null)])).changed).toBe(
      false,
    );
  });
});

describe('recasting', () => {
  it('replaces the previous list entirely', async () => {
    await replaceCast(db(), officer, 'test-show', [cast('Percy', 'daniel')]);
    await replaceCast(db(), officer, 'test-show', [cast('Grover', 'marleigh')]);

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('Grover');
  });

  it('writes nothing when the list is unchanged', async () => {
    await replaceCast(db(), officer, 'test-show', [cast('Percy', 'daniel')]);
    await env.DB.exec('DELETE FROM audit_events');

    const result = await replaceCast(db(), officer, 'test-show', [cast('Percy', 'daniel')]);
    expect(result.changed).toBe(false);
    expect(await auditRows()).toHaveLength(0);
  });

  // Casting is decided as a set, so one audit row per save records the actual
  // decision rather than a stream of per-row edits.
  it('records one audit row per save, not one per role', async () => {
    await replaceCast(db(), officer, 'test-show', [
      cast('Percy', 'daniel'),
      cast('Annabeth', 'marleigh'),
      cast('Grover', null),
    ]);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe(AUDIT_ACTION.ShowCastAssigned);
  });

  it('links every cast member as a related entity', async () => {
    await replaceCast(db(), officer, 'test-show', [
      cast('Percy', 'daniel'),
      cast('Annabeth', 'marleigh'),
    ]);
    const [row] = await auditRows();
    expect(row!.relatedEntities).toHaveLength(2);
  });
});

describe('castDiff', () => {
  // Rows are recreated on every save, so their ids mean nothing across saves.
  // The question a reader asks is "who is playing Percy now", which is about
  // the role.
  it('keys changes by role, not by row id', () => {
    const diff = castDiff(
      [{ role: 'Percy', memberId: 'daniel', tier: 'lead' }],
      [{ role: 'Percy', memberId: 'marleigh', tier: 'lead' }],
    );
    expect(diff).toEqual({
      Percy: {
        before: { memberId: 'daniel', tier: 'lead' },
        after: { memberId: 'marleigh', tier: 'lead' },
      },
    });
  });

  it('reports an added role', () => {
    const diff = castDiff([], [{ role: 'Grover', memberId: 'daniel', tier: 'lead' }]);
    expect(diff.Grover!.before).toBeNull();
  });

  it('reports a removed role', () => {
    const diff = castDiff([{ role: 'Cut Role', memberId: 'daniel', tier: 'lead' }], []);
    expect(diff['Cut Role']!.after).toBeNull();
  });

  it('reports a tier change even when the actor is unchanged', () => {
    const diff = castDiff(
      [{ role: 'Percy', memberId: 'daniel', tier: 'ensemble' }],
      [{ role: 'Percy', memberId: 'daniel', tier: 'lead' }],
    );
    expect(diff.Percy).toBeDefined();
  });

  it('is empty when nothing changed', () => {
    const list = [{ role: 'Percy', memberId: 'daniel', tier: 'lead' }];
    expect(castDiff(list, list)).toEqual({});
  });

  it('reports casting a previously uncast role', () => {
    const diff = castDiff(
      [{ role: 'Percy', memberId: null, tier: 'lead' }],
      [{ role: 'Percy', memberId: 'daniel', tier: 'lead' }],
    );
    expect(diff.Percy).toEqual({
      before: { memberId: null, tier: 'lead' },
      after: { memberId: 'daniel', tier: 'lead' },
    });
  });
});

describe('the public site reflects the assignment', () => {
  it('shows cast names reduced to their public form', async () => {
    await replaceCast(db(), officer, 'test-show', [cast('Percy', 'daniel', 'lead')]);
    const publicCast = await getCast(db(), 'test-show');
    // Members default to limited, so the surname must not appear.
    expect(publicCast[0]!.member?.name).toBe('Daniel D.');
    expect(publicCast[0]!.member?.href).toBeNull();
  });
});

describe('crew', () => {
  it('stores and replaces the production team', async () => {
    await replaceCrew(db(), officer, 'test-show', [
      { role: 'Stage Manager', memberId: 'daniel' },
    ]);
    await replaceCrew(db(), officer, 'test-show', [
      { role: 'Stage Manager', memberId: 'marleigh' },
    ]);

    const [row] = await auditRows().then((rows) =>
      rows.filter((r) => r.action === AUDIT_ACTION.ShowCrewAssigned).slice(-1),
    );
    expect(row!.diff).toHaveProperty('Stage Manager');
  });

  it('writes nothing when unchanged', async () => {
    await replaceCrew(db(), officer, 'test-show', [{ role: 'Props', memberId: null }]);
    await env.DB.exec('DELETE FROM audit_events');
    expect(
      (await replaceCrew(db(), officer, 'test-show', [{ role: 'Props', memberId: null }]))
        .changed,
    ).toBe(false);
  });
});
