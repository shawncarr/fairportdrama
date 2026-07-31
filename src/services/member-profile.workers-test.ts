import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '~/db/queries';
import { members, MEMBER_VISIBILITY } from '~/db/schema/content';
import { auditEvents, pendingEdits, PENDING_EDIT_STATUS } from '~/db/schema/governance';
import { AUDIT_ACTOR_KIND, type Actor } from '~/lib/audit/actor';
import { AUDIT_ACTION } from '~/lib/audit/constants';
import { approvePendingEdit, rejectPendingEdit, submitSelfEdit } from './member-profile';

const db = () => getDb(env.DB);

const student: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'user_student',
  label: 'Daniel Doser',
  ip: '203.0.113.9',
  userAgent: 'Chromebook',
};

const officer: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'user_officer',
  label: 'Ariana Toner',
  ip: '203.0.113.10',
  userAgent: 'Chromebook',
};

const seedMember = async (over: Partial<typeof members.$inferInsert> = {}) => {
  await db().insert(members).values({
    id: 'daniel-doser',
    name: 'Daniel Doser',
    grade: 'Senior',
    visibility: MEMBER_VISIBILITY.Limited,
    bio: 'Original bio.',
    isActive: true,
    ...over,
  });
};

const member = async () =>
  (await db().select().from(members).where(eq(members.id, 'daniel-doser')))[0]!;

const audits = async () => db().select().from(auditEvents);

beforeEach(async () => {
  await env.DB.exec('DELETE FROM audit_events');
  await env.DB.exec('DELETE FROM pending_edits');
  await env.DB.exec('DELETE FROM members');
});

describe('visibility applies immediately', () => {
  // A student who becomes uncomfortable must be able to withdraw without
  // waiting on an adult. That is the whole point of splitting by field.
  it('takes effect at once with no approval step', async () => {
    await seedMember({ visibility: MEMBER_VISIBILITY.Full });

    const result = await submitSelfEdit(db(), student, 'daniel-doser', {
      visibility: MEMBER_VISIBILITY.Limited,
    });

    expect(result.appliedImmediately).toEqual(['visibility']);
    expect(result.queuedForApproval).toEqual([]);
    expect((await member()).visibility).toBe(MEMBER_VISIBILITY.Limited);
    expect(await db().select().from(pendingEdits)).toHaveLength(0);
  });

  it('becoming public is also immediate, since the content already passed review', async () => {
    await seedMember({ visibility: MEMBER_VISIBILITY.Limited });
    await submitSelfEdit(db(), student, 'daniel-doser', {
      visibility: MEMBER_VISIBILITY.Full,
    });
    expect((await member()).visibility).toBe(MEMBER_VISIBILITY.Full);
  });

  it('is recorded under its own audit action, not a generic update', async () => {
    await seedMember({ visibility: MEMBER_VISIBILITY.Limited });
    await submitSelfEdit(db(), student, 'daniel-doser', {
      visibility: MEMBER_VISIBILITY.Full,
    });

    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe(AUDIT_ACTION.MemberVisibilityChanged);
    expect(rows[0]!.diff).toEqual({
      visibility: { before: 'limited', after: 'full' },
    });
    expect(rows[0]!.actorUserId).toBe('user_student');
    expect(rows[0]!.ip).toBe('203.0.113.9');
  });
});

describe('content changes are queued, never applied directly', () => {
  it('does not modify the member row', async () => {
    await seedMember();
    const result = await submitSelfEdit(db(), student, 'daniel-doser', {
      bio: 'A brand new bio.',
    });

    expect(result.queuedForApproval).toEqual(['bio']);
    // The critical assertion: nothing about the public record changed.
    expect((await member()).bio).toBe('Original bio.');
  });

  it('records the submission with the proposed value', async () => {
    await seedMember();
    await submitSelfEdit(db(), student, 'daniel-doser', { bio: 'A brand new bio.' });

    const [queued] = await db().select().from(pendingEdits);
    expect(queued!.status).toBe(PENDING_EDIT_STATUS.Pending);
    expect(queued!.proposed).toEqual({ bio: 'A brand new bio.' });
    expect(queued!.submittedByUserId).toBe('user_student');
  });

  it('queues instagram alongside bio, since it is also published', async () => {
    await seedMember();
    const result = await submitSelfEdit(db(), student, 'daniel-doser', {
      instagram: 'newhandle',
    });
    expect(result.queuedForApproval).toEqual(['instagram']);
    expect((await member()).instagram).toBeNull();
  });
});

describe('a single submission can do both', () => {
  it('applies visibility now and queues the bio', async () => {
    await seedMember({ visibility: MEMBER_VISIBILITY.Limited });

    const result = await submitSelfEdit(db(), student, 'daniel-doser', {
      visibility: MEMBER_VISIBILITY.Full,
      bio: 'Changed bio.',
    });

    expect(result.appliedImmediately).toEqual(['visibility']);
    expect(result.queuedForApproval).toEqual(['bio']);

    const row = await member();
    expect(row.visibility).toBe(MEMBER_VISIBILITY.Full);
    // Going public reveals the OLD approved bio, not the pending one.
    expect(row.bio).toBe('Original bio.');
  });
});

describe('no-op submissions', () => {
  it('writes nothing when nothing changed', async () => {
    await seedMember();
    const result = await submitSelfEdit(db(), student, 'daniel-doser', {
      visibility: MEMBER_VISIBILITY.Limited,
      bio: 'Original bio.',
    });

    expect(result.noChange).toBe(true);
    expect(await audits()).toHaveLength(0);
    expect(await db().select().from(pendingEdits)).toHaveLength(0);
  });
});

describe('approval', () => {
  it('applies the change and records both parties', async () => {
    await seedMember();
    await submitSelfEdit(db(), student, 'daniel-doser', { bio: 'Approved bio.' });
    const [queued] = await db().select().from(pendingEdits);

    await approvePendingEdit(db(), officer, queued!.id);

    expect((await member()).bio).toBe('Approved bio.');

    const approval = (await audits()).find(
      (a) => a.action === AUDIT_ACTION.MemberEditApproved,
    );
    // The approver is the actor; the submitter is carried in the payload, so
    // both names are on the row.
    expect(approval!.actorUserId).toBe('user_officer');
    expect((approval!.payload as Record<string, unknown>).submittedByUserId).toBe(
      'user_student',
    );
    expect(approval!.diff).toEqual({
      bio: { before: 'Original bio.', after: 'Approved bio.' },
    });
  });

  it('marks the edit approved so it cannot be applied twice', async () => {
    await seedMember();
    await submitSelfEdit(db(), student, 'daniel-doser', { bio: 'Once.' });
    const [queued] = await db().select().from(pendingEdits);

    expect((await approvePendingEdit(db(), officer, queued!.id)).applied).toBe(true);
    expect((await approvePendingEdit(db(), officer, queued!.id)).applied).toBe(false);
  });

  it('ignores an unknown edit id', async () => {
    expect((await approvePendingEdit(db(), officer, 'nope')).applied).toBe(false);
  });
});

describe('rejection', () => {
  it('leaves the member unchanged and records the reason', async () => {
    await seedMember();
    await submitSelfEdit(db(), student, 'daniel-doser', { bio: 'Rejected bio.' });
    const [queued] = await db().select().from(pendingEdits);

    await rejectPendingEdit(db(), officer, queued!.id, 'Please keep it about theater.');

    expect((await member()).bio).toBe('Original bio.');

    const [after] = await db().select().from(pendingEdits);
    expect(after!.status).toBe(PENDING_EDIT_STATUS.Rejected);
    expect(after!.reviewNote).toBe('Please keep it about theater.');

    const rejection = (await audits()).find(
      (a) => a.action === AUDIT_ACTION.MemberEditRejected,
    );
    expect(rejection!.actorUserId).toBe('user_officer');
  });

  it('cannot reject an already-approved edit', async () => {
    await seedMember();
    await submitSelfEdit(db(), student, 'daniel-doser', { bio: 'x' });
    const [queued] = await db().select().from(pendingEdits);
    await approvePendingEdit(db(), officer, queued!.id);

    expect((await rejectPendingEdit(db(), officer, queued!.id, null)).rejected).toBe(false);
  });
});

describe('atomicity', () => {
  // The change and its audit row go in the same D1 batch, so there is no state
  // where the site changed but nothing recorded it.
  it('every applied change has a corresponding audit row', async () => {
    await seedMember();
    await submitSelfEdit(db(), student, 'daniel-doser', {
      visibility: MEMBER_VISIBILITY.Full,
    });
    await submitSelfEdit(db(), student, 'daniel-doser', { bio: 'New.' });
    const [queued] = await db().select().from(pendingEdits);
    await approvePendingEdit(db(), officer, queued!.id);

    const actions = (await audits()).map((a) => a.action).sort();
    expect(actions).toEqual(
      [
        AUDIT_ACTION.MemberVisibilityChanged,
        AUDIT_ACTION.MemberEditSubmitted,
        AUDIT_ACTION.MemberEditApproved,
      ].sort(),
    );
  });
});
