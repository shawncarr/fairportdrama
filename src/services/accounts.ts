import { and, eq, ne, sql } from 'drizzle-orm';
import type { DB } from '~/db/queries';
import { session, user } from '~/db/schema/auth';
import { members } from '~/db/schema/content';
import { APP_ROLE, type AppRole } from '~/db/schema/governance';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { writeWithAudit } from '~/lib/audit/write';
import type { Actor } from '~/lib/audit/actor';

export type AccountResult = { ok: true } | { ok: false; error: string };

/**
 * Whether demoting this user would leave nobody able to manage accounts.
 *
 * `account.*` is granted to Admin alone, so the last admin losing the role
 * means no one can invite anybody, assign a role, or undo the mistake. The
 * only way back is editing D1 by hand against production.
 *
 * Handing the role over still works: promote the incoming admin first, then
 * demote yourself.
 */
async function wouldOrphanAdmin(db: DB, userId: string, nextRole: AppRole | null) {
  if (nextRole === APP_ROLE.Admin) return false;

  const [target] = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (target?.role !== APP_ROLE.Admin) return false;

  const [others] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(user)
    .where(and(eq(user.role, APP_ROLE.Admin), ne(user.id, userId)));

  return (others?.n ?? 0) === 0;
}

export async function assignRole(
  db: DB,
  actor: Actor,
  userId: string,
  role: AppRole | null,
): Promise<AccountResult> {
  const [target] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!target) return { ok: false, error: 'That account does not exist.' };
  if (target.role === role) return { ok: true };

  if (await wouldOrphanAdmin(db, userId, role)) {
    return {
      ok: false,
      error:
        'This is the only admin. Give someone else the admin role first, or nobody will be able to manage accounts.',
    };
  }

  await writeWithAudit(
    db,
    actor,
    [db.update(user).set({ role }).where(eq(user.id, userId))],
    {
      action: AUDIT_ACTION.AccountRoleChanged,
      targetKind: AUDIT_ENTITY_KIND.User,
      targetId: userId,
      diff: { role: { before: target.role, after: role } },
      // The email is copied on because it reads without a join and survives
      // the account being deleted later.
      payload: { email: target.email },
    },
  );

  return { ok: true };
}

/**
 * Ends an account's access without deleting it.
 *
 * Role goes to none and every session is torn down, so access stops on the
 * next request rather than whenever a cookie happens to expire. The row stays:
 * this is reversible for a student who comes back, and it keeps the account
 * resolvable when reading old audit rows.
 */
export async function revokeAccess(
  db: DB,
  actor: Actor,
  userId: string,
): Promise<AccountResult> {
  const [target] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!target) return { ok: false, error: 'That account does not exist.' };

  if (await wouldOrphanAdmin(db, userId, null)) {
    return {
      ok: false,
      error:
        'This is the only admin. Give someone else the admin role first, or nobody will be able to manage accounts.',
    };
  }

  const [open] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(session)
    .where(eq(session.userId, userId));

  await writeWithAudit(
    db,
    actor,
    [
      db.update(user).set({ role: null }).where(eq(user.id, userId)),
      db.delete(session).where(eq(session.userId, userId)),
    ],
    {
      action: AUDIT_ACTION.AccountRoleChanged,
      targetKind: AUDIT_ENTITY_KIND.User,
      targetId: userId,
      diff: { role: { before: target.role, after: null } },
      payload: {
        email: target.email,
        accessRevoked: true,
        sessionsEnded: open?.n ?? 0,
      },
    },
  );

  return { ok: true };
}

/**
 * Points an account at a member record, or clears the link.
 *
 * One account per member. Two accounts on one profile would let two people
 * edit the same student's bio and submit competing approval requests, and
 * would make "who changed this" ambiguous in a system whose whole answer to
 * that is the audit log.
 */
export async function linkMember(
  db: DB,
  actor: Actor,
  userId: string,
  memberId: string | null,
): Promise<AccountResult> {
  const [target] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!target) return { ok: false, error: 'That account does not exist.' };
  if ((target.memberId ?? null) === memberId) return { ok: true };

  if (memberId) {
    const [member] = await db
      .select({ id: members.id, name: members.name })
      .from(members)
      .where(eq(members.id, memberId))
      .limit(1);
    if (!member) return { ok: false, error: 'That member record does not exist.' };

    const [taken] = await db
      .select({ email: user.email })
      .from(user)
      .where(and(eq(user.memberId, memberId), ne(user.id, userId)))
      .limit(1);
    if (taken) {
      return {
        ok: false,
        error: `${member.name} is already linked to ${taken.email}. Unlink that account first.`,
      };
    }
  }

  await writeWithAudit(
    db,
    actor,
    [db.update(user).set({ memberId }).where(eq(user.id, userId))],
    {
      action: memberId
        ? AUDIT_ACTION.AccountMemberLinked
        : AUDIT_ACTION.AccountMemberUnlinked,
      targetKind: AUDIT_ENTITY_KIND.User,
      targetId: userId,
      diff: { memberId: { before: target.memberId ?? null, after: memberId } },
      payload: { email: target.email },
      relatedEntities: [
        ...(memberId ? [{ kind: AUDIT_ENTITY_KIND.Member, id: memberId }] : []),
        ...(target.memberId
          ? [{ kind: AUDIT_ENTITY_KIND.Member, id: target.memberId }]
          : []),
      ],
    },
  );

  return { ok: true };
}
