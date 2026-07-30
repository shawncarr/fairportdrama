import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { BatchItem } from 'drizzle-orm/batch';
import { auditEvents, type NewAuditEvent } from '~/db/schema/governance';
import { generateId } from '~/lib/id';
import { AUDIT_ACTOR_KIND, type Actor } from './actor';
import type { AuditAction, AuditEntityKind, RelatedEntity } from './constants';
import type { AuditDiff } from './diff';

export interface AuditEventInput {
  action: AuditAction;
  targetKind: AuditEntityKind;
  targetId: string;
  /** For creates and lifecycle events, where before/after is meaningless. */
  payload?: Record<string, unknown>;
  /** For updates. Produced by buildDiff. */
  diff?: AuditDiff;
  /** Parent and cross-cutting references. Never the target itself. */
  relatedEntities?: RelatedEntity[];
}

/**
 * Builds an audit row from the request actor and the event details.
 *
 * The actor is taken whole from middleware rather than assembled from
 * individual fields at the call site. Passing `actorKind` and `actorUserId`
 * separately is how a code path ends up claiming `kind: user` while carrying a
 * null id - a real defect that is easy to introduce and hard to notice,
 * because nothing fails at write time.
 */
export function buildAuditRow(
  actor: Actor,
  input: AuditEventInput,
  now: Date = new Date(),
): NewAuditEvent {
  return {
    id: generateId(now.getTime()),

    actorKind: actor.kind,
    actorUserId: actor.kind === AUDIT_ACTOR_KIND.User ? actor.id : null,
    actorLabel: actor.label,

    action: input.action,
    targetKind: input.targetKind,
    targetId: input.targetId,

    payload: input.payload ?? null,
    diff: input.diff ?? null,
    relatedEntities: input.relatedEntities ?? [],

    ip: actor.ip,
    userAgent: actor.userAgent,

    // Origin time, stamped when the row is built rather than when it lands,
    // so ordering reflects when things happened.
    createdAt: now.toISOString(),
  };
}

type DB = DrizzleD1Database<Record<string, unknown>>;

/**
 * Writes a change and its audit record atomically.
 *
 * D1 has no interactive transactions - the Drizzle D1 driver exposes `batch()`
 * and no `transaction()`. A batch is atomic, so the audit row and the change it
 * describes either both land or neither does. There is no state where the site
 * changed but nothing recorded it.
 *
 * This is why the audit write is a statement the caller batches rather than a
 * side effect it can forget to await.
 */
export async function writeWithAudit(
  db: DB,
  actor: Actor,
  writes: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]],
  event: AuditEventInput,
  now: Date = new Date(),
): Promise<void> {
  const auditWrite = db.insert(auditEvents).values(buildAuditRow(actor, event, now));
  await db.batch([...writes, auditWrite] as [
    BatchItem<'sqlite'>,
    ...BatchItem<'sqlite'>[],
  ]);
}

/**
 * For events with no accompanying data change - a denied sign-in, a read that
 * must be recorded. Not the common path; prefer writeWithAudit so the record
 * cannot drift from the change.
 */
export async function writeAuditOnly(
  db: DB,
  actor: Actor,
  event: AuditEventInput,
  now: Date = new Date(),
): Promise<void> {
  await db.insert(auditEvents).values(buildAuditRow(actor, event, now));
}
