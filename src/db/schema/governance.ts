import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { AuditActorKind } from '~/lib/audit/actor';
import type { AuditAction, AuditEntityKind, RelatedEntity } from '~/lib/audit/constants';
import type { AuditDiff } from '~/lib/audit/diff';

/**
 * Append-only record of every mutation.
 *
 * Written in the same transaction as the change it describes. There is no
 * outbox and no queue: this is a single-tenant site on one database, so the
 * delivery guarantees that pattern buys do not apply. If the audit insert
 * fails, the business write rolls back with it - there is no change without
 * its record.
 *
 * `created_at` is origin time, set when the row is built rather than when it
 * lands, so ordering is not distorted by anything downstream.
 */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    // UUID v7: sorts chronologically, so ORDER BY id matches ORDER BY created_at.
    id: text('id').primaryKey(),

    actorKind: text('actor_kind').$type<AuditActorKind>().notNull(),
    actorUserId: text('actor_user_id'),
    actorLabel: text('actor_label'),

    action: text('action').$type<AuditAction>().notNull(),
    targetKind: text('target_kind').$type<AuditEntityKind>().notNull(),
    targetId: text('target_id').notNull(),

    // `diff` for updates, `payload` for creates and lifecycle events. Keeping
    // these distinct is deliberate: collapsing before/after into `payload`
    // loses field-level change history exactly where it matters most.
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>(),
    diff: text('diff', { mode: 'json' }).$type<AuditDiff>(),

    // Parent and cross-cutting references, so "everything that touched this
    // show" needs no join table.
    relatedEntities: text('related_entities', { mode: 'json' })
      .$type<RelatedEntity[]>()
      .notNull()
      .default(sql`'[]'`),

    ip: text('ip'),
    userAgent: text('user_agent'),

    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_audit_target').on(t.targetKind, t.targetId, t.createdAt),
    index('idx_audit_actor').on(t.actorUserId, t.createdAt),
    index('idx_audit_action').on(t.action, t.createdAt),
  ],
);

export const PENDING_EDIT_STATUS = {
  Pending: 'pending',
  Approved: 'approved',
  Rejected: 'rejected',
} as const;
export type PendingEditStatus =
  (typeof PENDING_EDIT_STATUS)[keyof typeof PENDING_EDIT_STATUS];

/**
 * A proposed change awaiting review.
 *
 * `proposed` holds only the fields the submitter actually changed, not a full
 * entity snapshot. The approval preview and the resulting audit `diff` are
 * both derived from it by the same buildDiff function.
 */
export const pendingEdits = sqliteTable(
  'pending_edits',
  {
    id: text('id').primaryKey(),
    targetKind: text('target_kind').$type<AuditEntityKind>().notNull(),
    targetId: text('target_id').notNull(),
    proposed: text('proposed', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    submittedByUserId: text('submitted_by_user_id').notNull(),
    submittedAt: text('submitted_at').notNull(),
    status: text('status')
      .$type<PendingEditStatus>()
      .notNull()
      .default(PENDING_EDIT_STATUS.Pending),
    reviewedByUserId: text('reviewed_by_user_id'),
    reviewedAt: text('reviewed_at'),
    reviewNote: text('review_note'),
  },
  (t) => [
    index('idx_pending_status').on(t.status, t.submittedAt),
    index('idx_pending_target').on(t.targetKind, t.targetId),
  ],
);

export const APP_ROLE = {
  Admin: 'admin',
  Staff: 'staff',
  Officer: 'officer',
  Member: 'member',
} as const;
export type AppRole = (typeof APP_ROLE)[keyof typeof APP_ROLE];

/**
 * Access is invite-only. A successful Google authentication proves identity,
 * not authorization - without a matching invite or an existing user, no
 * account is created at all.
 */
export const invites = sqliteTable(
  'invites',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    role: text('role').$type<AppRole>().notNull(),
    // Optional: an invite may bind the new user to a member record, or not.
    // Board members and volunteers hold roles without a public profile.
    memberId: text('member_id'),
    token: text('token').notNull().unique(),
    expiresAt: text('expires_at').notNull(),
    acceptedAt: text('accepted_at'),
    acceptedByUserId: text('accepted_by_user_id'),
    revokedAt: text('revoked_at'),
    createdByUserId: text('created_by_user_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_invites_email').on(t.email),
    index('idx_invites_open').on(t.acceptedAt, t.revokedAt),
  ],
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type PendingEdit = typeof pendingEdits.$inferSelect;
export type Invite = typeof invites.$inferSelect;
