import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { DB } from '~/db/queries';
import {
  memberOffices,
  members,
  MEMBER_VISIBILITY,
  type MemberVisibility,
} from '~/db/schema/content';
import { auditEvents } from '~/db/schema/governance';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { ADVANCING_GRADES, GRADES, isGrade, nextGrade, type Grade } from '~/lib/grades';
import { buildDiff, isEmptyDiff } from '~/lib/audit/diff';
import { writeWithAudit } from '~/lib/audit/write';
import type { Actor } from '~/lib/audit/actor';
import { generateId } from '~/lib/id';
import { slugify } from './news';

// The grade vocabulary lives in lib/grades.ts alongside the rollover that
// moves members through it. Re-exported here because that is where callers
// already look for it.
export { GRADES, isGrade, type Grade };

export interface CreateMemberInput {
  name: string;
  grade: Grade;
  graduationYear?: number | null;
}

export type CreateMemberResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'invalid'; error: string }
  | {
      ok: false;
      reason: 'duplicate';
      /** The member already holding the slug this name produces. */
      existing: { id: string; name: string; grade: string; isActive: boolean };
      /** The id a deliberate duplicate would get. */
      suggestedId: string;
    };

/**
 * Adds a member to the roster.
 *
 * `visibility` is not an input. A new member always starts `limited`: whether
 * their name and photograph appear publicly is theirs to decide, and letting
 * whoever typed their name in pre-set it would put that back in someone
 * else's hands. They flip it themselves once they have an account.
 *
 * The slug is the primary key and comes from the name, so a name already on
 * the roster is a real conflict rather than a cosmetic one. It is returned for
 * the caller to resolve rather than silently suffixed: the usual cause is
 * re-adding somebody who is already there, and a second record for the same
 * student splits their cast credits and audit history across two ids.
 */
export async function createMember(
  db: DB,
  actor: Actor,
  input: CreateMemberInput,
  opts: { allowDuplicateName?: boolean } = {},
): Promise<CreateMemberResult> {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (name.length === 0) return { ok: false, reason: 'invalid', error: 'A member needs a name.' };

  const base = slugify(name);
  if (base.length === 0) {
    return {
      ok: false,
      reason: 'invalid',
      error: 'That name cannot be turned into a web address. Use letters and numbers.',
    };
  }

  const [clash] = await db.select().from(members).where(eq(members.id, base)).limit(1);

  if (clash && !opts.allowDuplicateName) {
    return {
      ok: false,
      reason: 'duplicate',
      existing: {
        id: clash.id,
        name: clash.name,
        grade: clash.grade,
        isActive: clash.isActive,
      },
      suggestedId: await nextFreeId(db, base),
    };
  }

  const id = clash ? await nextFreeId(db, base) : base;

  await writeWithAudit(
    db,
    actor,
    [
      db.insert(members).values({
        id,
        name,
        grade: input.grade,
        graduationYear: input.graduationYear ?? null,
        visibility: MEMBER_VISIBILITY.Limited,
        isActive: true,
      }),
    ],
    {
      action: AUDIT_ACTION.MemberCreated,
      targetKind: AUDIT_ENTITY_KIND.Member,
      targetId: id,
      payload: {
        name,
        grade: input.grade,
        // Noted explicitly so the log shows a new member started hidden,
        // rather than leaving it to be inferred from a missing field.
        visibility: MEMBER_VISIBILITY.Limited,
        duplicateOf: clash ? clash.id : undefined,
      },
    },
  );

  return { ok: true, id };
}

/** Finds the first free `name-2`, `name-3`, ... for a deliberate duplicate. */
async function nextFreeId(db: DB, base: string): Promise<string> {
  for (let n = 2; n < 50; n++) {
    const candidate = `${base}-${n}`;
    const rows = await db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.id, candidate))
      .limit(1);
    if (rows.length === 0) return candidate;
  }
  throw new Error(`No free id for ${base}`);
}

/**
 * Puts an inactive member back on the active roster.
 *
 * Separate from creating one so that a returning student keeps the id their
 * cast credits and audit history already point at.
 */
export async function reactivateMember(
  db: DB,
  actor: Actor,
  id: string,
): Promise<{ reactivated: boolean }> {
  const [current] = await db.select().from(members).where(eq(members.id, id)).limit(1);
  if (!current || current.isActive) return { reactivated: false };

  await writeWithAudit(
    db,
    actor,
    [
      db
        .update(members)
        .set({ isActive: true, updatedAt: new Date().toISOString() })
        .where(eq(members.id, id)),
    ],
    {
      action: AUDIT_ACTION.MemberUpdated,
      targetKind: AUDIT_ENTITY_KIND.Member,
      targetId: id,
      diff: { isActive: { before: false, after: true } },
    },
  );

  return { reactivated: true };
}

export interface UpdateMemberInput {
  name: string;
  grade: Grade;
  graduationYear: number | null;
  bio: string | null;
  photoImageId: string | null;
  instagram: string | null;
  visibility: MemberVisibility;
  isActive: boolean;
}

/**
 * Edits a member record.
 *
 * The caller decides which fields may be in the patch; this applies whatever
 * arrives. Officer status is gated on `member.setOfficer` at the route, which
 * is the only field on this form a student officer may not touch.
 *
 * Changing the name does not change the id. The id is the primary key and the
 * public URL, and rewriting it would orphan every cast credit and audit row
 * that points at it - those rows carry the id as plain text with no foreign
 * key, so nothing would error, they would just quietly stop resolving.
 */
export async function updateMember(
  db: DB,
  actor: Actor,
  id: string,
  patch: Partial<UpdateMemberInput>,
): Promise<{ updated: boolean }> {
  const [current] = await db.select().from(members).where(eq(members.id, id)).limit(1);
  if (!current) return { updated: false };

  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if ((current as Record<string, unknown>)[key] === value) continue;
    set[key] = value;
  }
  if (Object.keys(set).length === 0) return { updated: false };

  const diff = buildDiff(
    current as Record<string, unknown>,
    { ...current, ...set } as Record<string, unknown>,
    set,
  );
  if (isEmptyDiff(diff)) return { updated: false };

  await writeWithAudit(
    db,
    actor,
    [
      db
        .update(members)
        .set({ ...set, updatedAt: new Date().toISOString() })
        .where(eq(members.id, id)),
    ],
    {
      // A visibility change is a privacy-relevant event worth finding on its
      // own, even when it arrives alongside other edits.
      action:
        'visibility' in set
          ? AUDIT_ACTION.MemberVisibilityChanged
          : AUDIT_ACTION.MemberUpdated,
      targetKind: AUDIT_ENTITY_KIND.Member,
      targetId: id,
      diff,
      // Names the person edited, not just the id, so the log reads without a
      // join - and so it survives a later name change.
      payload: { memberName: current.name },
    },
  );

  return { updated: true };
}

/**
 * Honours a request to be taken off the site.
 *
 * Clears the photograph, biography, and social handle, forces visibility back
 * to `limited`, and drops the member from the active roster.
 *
 * The row itself stays. `show_cast` and `show_crew` reference it with
 * `onDelete: 'restrict'`, so a member who has ever been in a production cannot
 * be deleted - and unlinking them would destroy the record of who played the
 * part, which the printed playbill is then the only remaining copy of. What
 * survives is a first name and last initial against a role.
 */
export async function removeMemberInformation(
  db: DB,
  actor: Actor,
  id: string,
): Promise<{ removed: boolean }> {
  const [current] = await db.select().from(members).where(eq(members.id, id)).limit(1);
  if (!current) return { removed: false };

  const set = {
    bio: null,
    photoImageId: null,
    instagram: null,
    visibility: MEMBER_VISIBILITY.Limited,
    isActive: false,
  };

  await writeWithAudit(
    db,
    actor,
    [
      db
        .update(members)
        .set({ ...set, updatedAt: new Date().toISOString() })
        .where(eq(members.id, id)),
    ],
    {
      action: AUDIT_ACTION.MemberInformationRemoved,
      targetKind: AUDIT_ENTITY_KIND.Member,
      targetId: id,
      diff: buildDiff(
        current as Record<string, unknown>,
        { ...current, ...set } as Record<string, unknown>,
        set,
      ),
      // "Who honoured my removal request, and when" is the question this row
      // exists to answer, so the name is kept even though the record remains.
      payload: { memberName: current.name },
    },
  );

  return { removed: true };
}

// ------------------------------------------------------------------ offices

/**
 * Records a term of office.
 *
 * Offices are their own rows rather than a flag on the member, so a term
 * survives the person leaving it. A student who was Treasurer keeps that on
 * their profile after they hand it over, which is the point - it is the sort
 * of thing that ends up on a college application.
 */
export async function addOffice(
  db: DB,
  actor: Actor,
  memberId: string,
  input: { title: string; startYear: number; endYear?: number | null },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const title = input.title.trim();
  if (title.length === 0) return { ok: false, error: 'An office needs a title.' };

  const [member] = await db.select().from(members).where(eq(members.id, memberId)).limit(1);
  if (!member) return { ok: false, error: 'That member does not exist.' };

  const endYear = input.endYear ?? null;
  if (endYear !== null && endYear < input.startYear) {
    return { ok: false, error: 'A term cannot end before it starts.' };
  }

  const id = generateId();

  await writeWithAudit(
    db,
    actor,
    [
      db.insert(memberOffices).values({
        id,
        memberId,
        title,
        startYear: input.startYear,
        endYear,
      }),
    ],
    {
      action: AUDIT_ACTION.MemberOfficeChanged,
      targetKind: AUDIT_ENTITY_KIND.Member,
      targetId: memberId,
      payload: { added: true, title, startYear: input.startYear, endYear, memberName: member.name },
    },
  );

  return { ok: true, id };
}

/** Closes a term, which is what stops someone being a current officer. */
export async function endOffice(
  db: DB,
  actor: Actor,
  officeId: string,
  endYear: number,
): Promise<{ ended: boolean }> {
  const [office] = await db
    .select()
    .from(memberOffices)
    .where(eq(memberOffices.id, officeId))
    .limit(1);
  if (!office || office.endYear !== null) return { ended: false };
  if (endYear < office.startYear) return { ended: false };

  await writeWithAudit(
    db,
    actor,
    [db.update(memberOffices).set({ endYear }).where(eq(memberOffices.id, officeId))],
    {
      action: AUDIT_ACTION.MemberOfficeChanged,
      targetKind: AUDIT_ENTITY_KIND.Member,
      targetId: office.memberId,
      diff: { endYear: { before: null, after: endYear } },
      payload: { title: office.title, startYear: office.startYear },
    },
  );

  return { ended: true };
}

/** For a term recorded by mistake. Ending one is the usual action. */
export async function deleteOffice(
  db: DB,
  actor: Actor,
  officeId: string,
): Promise<{ deleted: boolean }> {
  const [office] = await db
    .select()
    .from(memberOffices)
    .where(eq(memberOffices.id, officeId))
    .limit(1);
  if (!office) return { deleted: false };

  await writeWithAudit(
    db,
    actor,
    [db.delete(memberOffices).where(eq(memberOffices.id, officeId))],
    {
      action: AUDIT_ACTION.MemberOfficeChanged,
      targetKind: AUDIT_ENTITY_KIND.Member,
      targetId: office.memberId,
      // Kept on the row: a deleted office cannot be joined against later, and
      // "who removed my term as Treasurer" is exactly what gets asked.
      payload: {
        deleted: true,
        title: office.title,
        startYear: office.startYear,
        endYear: office.endYear,
      },
    },
  );

  return { deleted: true };
}

export async function getOffices(db: DB, memberId: string) {
  return db
    .select()
    .from(memberOffices)
    .where(eq(memberOffices.memberId, memberId))
    .orderBy(desc(memberOffices.startYear));
}

// ------------------------------------------------- school year rollover

export interface AdvanceGradesPreview {
  /** How many members sit in each advancing grade right now. */
  counts: { grade: Grade; next: Grade; count: number }[];
  total: number;
  graduating: number;
}

/** What the rollover would do, without doing it. */
export async function previewAdvanceGrades(db: DB): Promise<AdvanceGradesPreview> {
  const rows = await db
    .select({ grade: members.grade, count: sql<number>`COUNT(*)` })
    .from(members)
    .where(eq(members.isActive, true))
    .groupBy(members.grade);

  const byGrade = new Map(rows.map((r) => [r.grade, Number(r.count)]));
  const counts = ADVANCING_GRADES.map((grade) => ({
    grade,
    next: nextGrade(grade)!,
    count: byGrade.get(grade) ?? 0,
  })).filter((c) => c.count > 0);

  return {
    counts,
    total: counts.reduce((n, c) => n + c.count, 0),
    graduating: byGrade.get('Senior') ?? 0,
  };
}

export type AdvanceGradesResult =
  | { ok: true; advanced: number; graduated: number }
  | { ok: false; reason: 'already-run' };

/**
 * Moves every student on one grade and graduates the seniors.
 *
 * Guarded against running twice for the same school year, which is the failure
 * that actually matters: there is no undo, and a second pass would put this
 * year's freshmen into junior year and graduate the juniors. The guard reads
 * the audit log rather than a flag column - the log already has to record this,
 * and a separate marker could disagree with it.
 *
 * Written one member at a time, like the bulk visibility change, so each grade
 * lands on its own audit row. "Why does my profile say Alumni" is a question
 * about one person.
 */
export async function advanceGrades(
  db: DB,
  actor: Actor,
  schoolYear: number,
): Promise<AdvanceGradesResult> {
  const [alreadyRun] = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, AUDIT_ACTION.MemberGradeAdvanced),
        sql`json_extract(${auditEvents.payload}, '$.schoolYear') = ${schoolYear}`,
      ),
    )
    .limit(1);

  if (alreadyRun) return { ok: false, reason: 'already-run' };

  const roster = await db
    .select({ id: members.id, grade: members.grade })
    .from(members)
    .where(eq(members.isActive, true))
    .orderBy(asc(members.id));

  let advanced = 0;
  let graduated = 0;

  for (const row of roster) {
    const next = nextGrade(row.grade);
    if (next === null) continue;

    await writeWithAudit(
      db,
      actor,
      [
        db
          .update(members)
          .set({ grade: next, updatedAt: new Date().toISOString() })
          .where(eq(members.id, row.id)),
      ],
      {
        action: AUDIT_ACTION.MemberGradeAdvanced,
        targetKind: AUDIT_ENTITY_KIND.Member,
        targetId: row.id,
        diff: { grade: { before: row.grade, after: next } },
        payload: { schoolYear },
      },
    );

    advanced++;
    if (next === 'Alumni') graduated++;
  }

  return { ok: true, advanced, graduated };
}
