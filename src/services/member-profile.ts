import { eq } from 'drizzle-orm';
import type { DB } from '~/db/queries';
import { members, MEMBER_VISIBILITY, type MemberVisibility } from '~/db/schema/content';
import { pendingEdits, PENDING_EDIT_STATUS } from '~/db/schema/governance';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { buildDiff, isEmptyDiff } from '~/lib/audit/diff';
import { writeWithAudit } from '~/lib/audit/write';
import type { Actor } from '~/lib/audit/actor';
import { generateId } from '~/lib/id';
import { SELF_EDIT_FIELDS, selfEditNeedsApproval } from '~/lib/auth/permissions';

export interface SelfEditInput {
  visibility?: MemberVisibility;
  bio?: string | null;
  photoImageId?: string | null;
  instagram?: string | null;
}

export interface SelfEditResult {
  appliedImmediately: string[];
  queuedForApproval: string[];
  noChange: boolean;
}

/**
 * Applies a member's edits to their own profile.
 *
 * The split is by field, not by direction. Flipping visibility to `full` only
 * reveals a bio and photo that already passed review, so the toggle is not the
 * risky action - the content is. A student who becomes uncomfortable can
 * withdraw immediately without waiting on an adult, which is the whole point.
 */
export async function submitSelfEdit(
  db: DB,
  actor: Actor,
  memberId: string,
  input: SelfEditInput,
): Promise<SelfEditResult> {
  const [current] = await db.select().from(members).where(eq(members.id, memberId)).limit(1);
  if (!current) throw new Error(`Unknown member: ${memberId}`);

  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) patch[key] = value;
  }

  const immediate: Record<string, unknown> = {};
  const queued: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(patch)) {
    // Unchanged fields are dropped before anything is written, so a form
    // resubmit does not create an empty approval or a no-op audit row.
    if ((current as Record<string, unknown>)[key] === value) continue;
    if (selfEditNeedsApproval(key, value)) queued[key] = value;
    else if (
      (SELF_EDIT_FIELDS.immediate as readonly string[]).includes(key) ||
      // Clearing a reviewed field. Withdrawing content never waits on approval.
      (SELF_EDIT_FIELDS.requiresApproval as readonly string[]).includes(key)
    ) {
      immediate[key] = value;
    }
  }

  const result: SelfEditResult = {
    appliedImmediately: Object.keys(immediate),
    queuedForApproval: Object.keys(queued),
    noChange: Object.keys(immediate).length === 0 && Object.keys(queued).length === 0,
  };

  if (result.noChange) return result;

  if (Object.keys(immediate).length > 0) {
    const after = { ...current, ...immediate };
    const diff = buildDiff(
      current as Record<string, unknown>,
      after as Record<string, unknown>,
      immediate,
    );

    if (!isEmptyDiff(diff)) {
      await writeWithAudit(
        db,
        actor,
        [
          db
            .update(members)
            .set({ ...immediate, updatedAt: new Date().toISOString() })
            .where(eq(members.id, memberId)),
        ],
        {
          // Visibility changes get their own action rather than a generic
          // update: it is a privacy-relevant event worth finding on its own.
          action:
            'visibility' in immediate
              ? AUDIT_ACTION.MemberVisibilityChanged
              : AUDIT_ACTION.MemberUpdated,
          targetKind: AUDIT_ENTITY_KIND.Member,
          targetId: memberId,
          diff,
        },
      );
    }
  }

  if (Object.keys(queued).length > 0) {
    const editId = generateId();
    await writeWithAudit(
      db,
      actor,
      [
        db.insert(pendingEdits).values({
          id: editId,
          targetKind: AUDIT_ENTITY_KIND.Member,
          targetId: memberId,
          proposed: queued,
          submittedByUserId: actor.id ?? 'system',
          submittedAt: new Date().toISOString(),
          status: PENDING_EDIT_STATUS.Pending,
        }),
      ],
      {
        action: AUDIT_ACTION.MemberEditSubmitted,
        targetKind: AUDIT_ENTITY_KIND.PendingEdit,
        targetId: editId,
        payload: { fields: Object.keys(queued) },
        relatedEntities: [{ kind: AUDIT_ENTITY_KIND.Member, id: memberId }],
      },
    );
  }

  return result;
}

/**
 * Approves a queued edit and applies it.
 *
 * The approver is recorded as the audit actor and the submitter is carried in
 * the payload, so both parties are on the row. Officers hold this permission
 * by explicit decision: the control is accountability after the fact rather
 * than an adult gate before publication.
 */
export async function approvePendingEdit(
  db: DB,
  actor: Actor,
  editId: string,
): Promise<{ applied: boolean }> {
  const [edit] = await db.select().from(pendingEdits).where(eq(pendingEdits.id, editId)).limit(1);
  if (!edit || edit.status !== PENDING_EDIT_STATUS.Pending) return { applied: false };

  const [current] = await db
    .select()
    .from(members)
    .where(eq(members.id, edit.targetId))
    .limit(1);
  if (!current) return { applied: false };

  const proposed = edit.proposed as Record<string, unknown>;
  const after = { ...current, ...proposed };
  const diff = buildDiff(
    current as Record<string, unknown>,
    after as Record<string, unknown>,
    proposed,
  );
  const now = new Date().toISOString();

  await writeWithAudit(
    db,
    actor,
    [
      db
        .update(members)
        .set({ ...proposed, updatedAt: now })
        .where(eq(members.id, edit.targetId)),
      db
        .update(pendingEdits)
        .set({
          status: PENDING_EDIT_STATUS.Approved,
          reviewedByUserId: actor.id,
          reviewedAt: now,
        })
        .where(eq(pendingEdits.id, editId)),
    ],
    {
      action: AUDIT_ACTION.MemberEditApproved,
      targetKind: AUDIT_ENTITY_KIND.Member,
      targetId: edit.targetId,
      diff,
      payload: { pendingEditId: editId, submittedByUserId: edit.submittedByUserId },
      relatedEntities: [{ kind: AUDIT_ENTITY_KIND.PendingEdit, id: editId }],
    },
  );

  return { applied: true };
}

export async function rejectPendingEdit(
  db: DB,
  actor: Actor,
  editId: string,
  note: string | null,
): Promise<{ rejected: boolean }> {
  const [edit] = await db.select().from(pendingEdits).where(eq(pendingEdits.id, editId)).limit(1);
  if (!edit || edit.status !== PENDING_EDIT_STATUS.Pending) return { rejected: false };

  const now = new Date().toISOString();

  await writeWithAudit(
    db,
    actor,
    [
      db
        .update(pendingEdits)
        .set({
          status: PENDING_EDIT_STATUS.Rejected,
          reviewedByUserId: actor.id,
          reviewedAt: now,
          reviewNote: note,
        })
        .where(eq(pendingEdits.id, editId)),
    ],
    {
      action: AUDIT_ACTION.MemberEditRejected,
      targetKind: AUDIT_ENTITY_KIND.Member,
      targetId: edit.targetId,
      payload: {
        pendingEditId: editId,
        submittedByUserId: edit.submittedByUserId,
        // The note is stored on the row for the submitter to read; recording it
        // here too keeps the reason with the decision in the audit trail.
        note,
      },
      relatedEntities: [{ kind: AUDIT_ENTITY_KIND.PendingEdit, id: editId }],
    },
  );

  return { rejected: true };
}

export const VISIBILITY_LABELS: Record<MemberVisibility, string> = {
  [MEMBER_VISIBILITY.Full]: 'Full name, photo, and bio',
  [MEMBER_VISIBILITY.Limited]: 'First name and last initial only',
};
