import { eq } from 'drizzle-orm';
import type { DB } from '~/db/queries';
import { members, MEMBER_VISIBILITY, type MemberVisibility } from '~/db/schema/content';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { buildDiff, isEmptyDiff } from '~/lib/audit/diff';
import { writeWithAudit } from '~/lib/audit/write';
import type { Actor } from '~/lib/audit/actor';
import { slugify } from './news';

/** The grades already in use, plus the two non-student values. */
export const GRADES = [
  'Freshman',
  'Sophomore',
  'Junior',
  'Senior',
  'Alumni',
  'Faculty',
] as const;

export type Grade = (typeof GRADES)[number];

export const isGrade = (v: string): v is Grade => (GRADES as readonly string[]).includes(v);

export interface CreateMemberInput {
  name: string;
  grade: Grade;
  graduationYear?: number | null;
  /** Only set by a caller holding member.setOfficer. */
  isOfficer?: boolean;
  officerTitle?: string | null;
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
        isOfficer: input.isOfficer ?? false,
        officerTitle: input.officerTitle ?? null,
      }),
    ],
    {
      action: AUDIT_ACTION.MemberCreated,
      targetKind: AUDIT_ENTITY_KIND.Member,
      targetId: id,
      payload: {
        name,
        grade: input.grade,
        // Recorded because it is the one field on this form a student officer
        // is not allowed to set.
        isOfficer: input.isOfficer ?? false,
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
  isOfficer: boolean;
  officerTitle: string | null;
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
