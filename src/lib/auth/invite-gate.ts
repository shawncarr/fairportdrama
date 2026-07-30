import type { AppRole } from '~/db/schema/governance';

export interface OpenInvite {
  id: string;
  email: string;
  role: AppRole;
  memberId: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export type GateDecision =
  | { allow: true; invite: OpenInvite }
  | { allow: false; reason: GateDenialReason };

export const GATE_DENIAL = {
  NoInvite: 'no_invite',
  Expired: 'expired',
  AlreadyAccepted: 'already_accepted',
  Revoked: 'revoked',
} as const;

export type GateDenialReason = (typeof GATE_DENIAL)[keyof typeof GATE_DENIAL];

export const GATE_DENIAL_MESSAGE: Record<GateDenialReason, string> = {
  [GATE_DENIAL.NoInvite]:
    'This account has not been invited. Ask a Drama Club board member to send you an invite.',
  [GATE_DENIAL.Expired]:
    'That invite has expired. Ask a board member to send a new one.',
  [GATE_DENIAL.AlreadyAccepted]:
    'That invite was already used. Try signing in with the account you set up.',
  [GATE_DENIAL.Revoked]:
    'That invite is no longer valid. Ask a board member to send a new one.',
};

/**
 * Decides whether an email address may become an account.
 *
 * Access is invite-only. Authenticating with Google proves who someone is; it
 * proves nothing about whether they belong here, and Better Auth will happily
 * create a user on first social sign-in unless something stops it.
 *
 * Note this deliberately does NOT rely on Better Auth's `disableImplicitSignUp`
 * + `requestSignUp` pair. That flag is supplied by the client, so it is a UX
 * affordance rather than a security boundary - anything calling the API can
 * set it. The invites table is server-side state that cannot be forged.
 *
 * Kept free of database and framework types so the decision logic is directly
 * testable.
 */
export function decideInviteGate(
  invites: OpenInvite[],
  now: Date = new Date(),
): GateDecision {
  if (invites.length === 0) {
    return { allow: false, reason: GATE_DENIAL.NoInvite };
  }

  const usable = invites.filter(
    (i) => i.revokedAt === null && i.acceptedAt === null && new Date(i.expiresAt) > now,
  );

  if (usable.length > 0) {
    // Most recently expiring wins, so reissuing an invite supersedes an older
    // one without needing to revoke it first.
    const best = usable.reduce((a, b) =>
      new Date(a.expiresAt) >= new Date(b.expiresAt) ? a : b,
    );
    return { allow: true, invite: best };
  }

  // Nothing usable. Report the most informative reason rather than a blanket
  // denial, so the person knows whether to ask for a new invite or to try a
  // different account.
  if (invites.some((i) => i.acceptedAt !== null)) {
    return { allow: false, reason: GATE_DENIAL.AlreadyAccepted };
  }
  if (invites.some((i) => i.revokedAt !== null)) {
    return { allow: false, reason: GATE_DENIAL.Revoked };
  }
  return { allow: false, reason: GATE_DENIAL.Expired };
}

/** Emails are matched case-insensitively; providers do not normalise casing. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
