import { and, eq, isNull } from 'drizzle-orm';
import type { DB } from '~/db/queries';
import { invites, type AppRole } from '~/db/schema/governance';
import { members } from '~/db/schema/content';
import { user } from '~/db/schema/auth';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from '~/lib/audit/constants';
import { writeWithAudit } from '~/lib/audit/write';
import type { Actor } from '~/lib/audit/actor';
import { generateId } from '~/lib/id';
import { normalizeEmail } from '~/lib/auth/invite-gate';
import { emailShell, sendEmail } from '~/lib/email';
import { escapeHtml } from '~/lib/html';

/** Invites expire rather than living forever as a standing credential. */
export const INVITE_TTL_DAYS = 14;

export interface CreateInviteInput {
  email: string;
  role: AppRole;
  memberId: string | null;
}

export type CreateInviteResult =
  | { ok: true; inviteId: string; emailed: boolean; emailError?: string }
  | { ok: false; error: string };

/**
 * Creates an invite and emails the recipient.
 *
 * The invite row is written first and kept even if the email fails. Rolling
 * back would lose the record of who was invited and leave an Admin with no way
 * to resend - the failure is reported instead so they can retry.
 */
export async function createInvite(
  db: DB,
  actor: Actor,
  emailBinding: SendEmail,
  siteUrl: string,
  input: CreateInviteInput,
): Promise<CreateInviteResult> {
  const email = normalizeEmail(input.email);
  if (!email.includes('@')) return { ok: false, error: 'That does not look like an email address.' };

  // An open invite for the same address would leave two usable credentials.
  const existing = await db
    .select({ id: invites.id })
    .from(invites)
    .where(and(eq(invites.email, email), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
    .limit(1);
  if (existing.length > 0) {
    return { ok: false, error: 'That address already has an open invite. Revoke it first.' };
  }

  if (input.memberId) {
    const member = await db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.id, input.memberId))
      .limit(1);
    if (member.length === 0) return { ok: false, error: 'That member record does not exist.' };
  }

  const inviteId = generateId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 864e5).toISOString();

  await writeWithAudit(
    db,
    actor,
    [
      db.insert(invites).values({
        id: inviteId,
        email,
        role: input.role,
        memberId: input.memberId,
        token: generateId(),
        expiresAt,
        createdByUserId: actor.id ?? 'system',
        createdAt: now.toISOString(),
      }),
    ],
    {
      action: AUDIT_ACTION.AccountInvited,
      targetKind: AUDIT_ENTITY_KIND.Invite,
      targetId: inviteId,
      // The address is recorded because who was granted access is the point of
      // the record. The token is not - it is a credential.
      payload: { email, role: input.role, memberId: input.memberId },
      relatedEntities: input.memberId
        ? [{ kind: AUDIT_ENTITY_KIND.Member, id: input.memberId }]
        : [],
    },
  );

  const signInUrl = new URL('/admin/sign-in', siteUrl).toString();
  const result = await sendEmail(emailBinding, {
    to: email,
    subject: 'You have been invited to help run the Fairport Drama Club site',
    html: emailShell(
      'You have been invited',
      `<p style="margin:0 0 20px;">A Drama Club Boosters board member has given you access to update the Fairport Drama Club website.</p>
       <p style="margin:0 0 20px;">Sign in with this email address, or with your school Google account if it uses the same address.</p>
       <p style="margin:0 0 20px;"><a href="${escapeHtml(signInUrl)}" style="display:inline-block;background:#cc0000;color:#ffffff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600;">Sign in</a></p>
       <p style="margin:0;font-size:13px;color:#57534e;">This invitation expires in ${INVITE_TTL_DAYS} days.</p>`,
    ),
    text: `You have been invited to help run the Fairport Drama Club website.\n\nSign in at ${signInUrl} using this email address, or with your school Google account if it uses the same address.\n\nThis invitation expires in ${INVITE_TTL_DAYS} days.`,
  });

  return result.ok
    ? { ok: true, inviteId, emailed: true }
    : { ok: true, inviteId, emailed: false, emailError: result.message };
}

export async function revokeInvite(
  db: DB,
  actor: Actor,
  inviteId: string,
): Promise<{ revoked: boolean }> {
  const [invite] = await db.select().from(invites).where(eq(invites.id, inviteId)).limit(1);
  if (!invite || invite.acceptedAt || invite.revokedAt) return { revoked: false };

  await writeWithAudit(
    db,
    actor,
    [
      db
        .update(invites)
        .set({ revokedAt: new Date().toISOString() })
        .where(eq(invites.id, inviteId)),
    ],
    {
      action: AUDIT_ACTION.AccountInviteRevoked,
      targetKind: AUDIT_ENTITY_KIND.Invite,
      targetId: inviteId,
      payload: { email: invite.email },
    },
  );

  return { revoked: true };
}

export type InviteStatus = 'open' | 'accepted' | 'revoked' | 'expired';

export function inviteStatus(
  invite: { acceptedAt: string | null; revokedAt: string | null; expiresAt: string },
  now = new Date(),
): InviteStatus {
  if (invite.revokedAt) return 'revoked';
  if (invite.acceptedAt) return 'accepted';
  if (new Date(invite.expiresAt) <= now) return 'expired';
  return 'open';
}

// ------------------------------------------------------------ bulk invite

/** What will happen to one pasted line, decided before anything is sent. */
export type BulkInviteOutcome =
  | 'invite'
  | 'has-account'
  | 'already-invited'
  | 'invalid'
  | 'duplicate';

export interface BulkInviteEntry {
  /** 1-based, so an invalid line can be pointed at in the textarea. */
  line: number;
  raw: string;
  email: string;
  outcome: BulkInviteOutcome;
}

export interface BulkInvitePlan {
  entries: BulkInviteEntry[];
  /** Addresses that will actually be invited, in order. */
  toInvite: string[];
  counts: Record<BulkInviteOutcome, number>;
}

/**
 * Works out what a pasted list would do, without doing any of it.
 *
 * The preview and the send both come from here, so what the confirmation
 * screen promises is what runs. Inviting eighty students is not an action to
 * discover the shape of halfway through - and an invite is a credential, so
 * "it skipped some, I think" is not an acceptable outcome.
 */
export async function planBulkInvites(db: DB, pasted: string): Promise<BulkInvitePlan> {
  const lines = pasted
    .split(/[\r\n,;]+/)
    .map((raw, i) => ({ line: i + 1, raw: raw.trim() }))
    .filter((l) => l.raw.length > 0);

  const emails = [...new Set(lines.map((l) => normalizeEmail(l.raw)))];

  // Looked up in one pass rather than per line: eighty lines would otherwise
  // be a hundred and sixty queries, and D1 caps how many parameters a single
  // statement may bind, so a list of addresses cannot be passed in either.
  const existingAccounts = new Set(
    (await db.select({ email: user.email }).from(user)).map((r) => normalizeEmail(r.email)),
  );
  const openInvites = new Set(
    (
      await db
        .select({ email: invites.email, expiresAt: invites.expiresAt })
        .from(invites)
        .where(and(isNull(invites.acceptedAt), isNull(invites.revokedAt)))
    )
      .filter((r) => new Date(r.expiresAt).getTime() > Date.now())
      .map((r) => normalizeEmail(r.email)),
  );

  const seen = new Set<string>();
  const entries: BulkInviteEntry[] = lines.map(({ line, raw }) => {
    const email = normalizeEmail(raw);
    const outcome: BulkInviteOutcome = !isEmailish(email)
      ? 'invalid'
      : seen.has(email)
        ? 'duplicate'
        : existingAccounts.has(email)
          ? 'has-account'
          : openInvites.has(email)
            ? 'already-invited'
            : 'invite';

    if (outcome === 'invite') seen.add(email);
    return { line, raw, email, outcome };
  });

  const counts: Record<BulkInviteOutcome, number> = {
    invite: 0,
    'has-account': 0,
    'already-invited': 0,
    invalid: 0,
    duplicate: 0,
  };
  for (const e of entries) counts[e.outcome]++;

  return {
    entries,
    toInvite: entries.filter((e) => e.outcome === 'invite').map((e) => e.email),
    counts,
  };
}

/**
 * Deliberately stricter than createInvite's `includes('@')`.
 *
 * A pasted list is typed by hand somewhere else and arrives with stray names
 * and trailing punctuation in it. Catching those at the preview is the whole
 * point; letting one through creates an invite nobody can use and an audit row
 * that says access was granted to something that is not an address.
 */
const isEmailish = (v: string): boolean => /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(v);

export interface BulkInviteResult {
  sent: number;
  created: number;
  failed: { email: string; error: string }[];
}

/**
 * Sends the invites a plan named.
 *
 * Each one goes through createInvite, so a bulk send and a single send produce
 * the same row, the same audit entry, and the same email - there is no second
 * path that could drift from the one already tested.
 */
export async function sendBulkInvites(
  db: DB,
  actor: Actor,
  emailBinding: SendEmail,
  siteUrl: string,
  emails: string[],
  role: AppRole,
): Promise<BulkInviteResult> {
  const result: BulkInviteResult = { sent: 0, created: 0, failed: [] };

  for (const email of emails) {
    const one = await createInvite(db, actor, emailBinding, siteUrl, {
      email,
      role,
      memberId: null,
    });

    if (!one.ok) {
      result.failed.push({ email, error: one.error });
      continue;
    }

    result.created++;
    // Counted separately: the invite exists and is usable either way, so a
    // failed send is something to tell somebody about, not a failed invite.
    if (one.emailed) result.sent++;
    else result.failed.push({ email, error: one.emailError ?? 'The email could not be sent.' });
  }

  return result;
}
