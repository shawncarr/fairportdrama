import { describe, expect, it } from 'vitest';
import { APP_ROLE } from '~/db/schema/governance';
import {
  GATE_DENIAL,
  decideInviteGate,
  normalizeEmail,
  type OpenInvite,
} from './invite-gate';

const NOW = new Date('2026-07-30T12:00:00.000Z');

const invite = (over: Partial<OpenInvite> = {}): OpenInvite => ({
  id: 'inv_1',
  email: 'student@fairportschools.org',
  role: APP_ROLE.Member,
  memberId: 'daniel-doser',
  expiresAt: '2026-08-30T12:00:00.000Z',
  acceptedAt: null,
  revokedAt: null,
  ...over,
});

describe('invite gate', () => {
  // The central rule. A valid Google login with no invite must not become an
  // account - authentication is not authorization.
  it('denies an address with no invite at all', () => {
    const decision = decideInviteGate([], NOW);
    expect(decision).toEqual({ allow: false, reason: GATE_DENIAL.NoInvite });
  });

  it('allows a valid open invite and returns it', () => {
    const decision = decideInviteGate([invite()], NOW);
    expect(decision.allow).toBe(true);
    if (decision.allow) {
      expect(decision.invite.role).toBe(APP_ROLE.Member);
      expect(decision.invite.memberId).toBe('daniel-doser');
    }
  });

  it('denies an expired invite', () => {
    const decision = decideInviteGate(
      [invite({ expiresAt: '2026-07-29T12:00:00.000Z' })],
      NOW,
    );
    expect(decision).toEqual({ allow: false, reason: GATE_DENIAL.Expired });
  });

  it('denies an invite expiring exactly now', () => {
    const decision = decideInviteGate(
      [invite({ expiresAt: NOW.toISOString() })],
      NOW,
    );
    expect(decision.allow).toBe(false);
  });

  it('denies a revoked invite even if it has not expired', () => {
    const decision = decideInviteGate(
      [invite({ revokedAt: '2026-07-20T00:00:00.000Z' })],
      NOW,
    );
    expect(decision).toEqual({ allow: false, reason: GATE_DENIAL.Revoked });
  });

  // Without this, an invite link is a reusable credential: anyone who obtains
  // a forwarded invite email could create a second account on it.
  it('denies an invite that was already accepted', () => {
    const decision = decideInviteGate(
      [invite({ acceptedAt: '2026-07-25T00:00:00.000Z' })],
      NOW,
    );
    expect(decision).toEqual({ allow: false, reason: GATE_DENIAL.AlreadyAccepted });
  });

  describe('multiple invites for one address', () => {
    it('uses the open one when an older invite was already accepted', () => {
      const decision = decideInviteGate(
        [
          invite({ id: 'old', acceptedAt: '2026-01-01T00:00:00.000Z' }),
          invite({ id: 'new', role: APP_ROLE.Officer }),
        ],
        NOW,
      );
      expect(decision.allow).toBe(true);
      if (decision.allow) expect(decision.invite.id).toBe('new');
    });

    it('prefers the invite that expires latest, so a reissue supersedes', () => {
      const decision = decideInviteGate(
        [
          invite({ id: 'first', expiresAt: '2026-08-01T00:00:00.000Z' }),
          invite({
            id: 'reissued',
            expiresAt: '2026-09-01T00:00:00.000Z',
            role: APP_ROLE.Admin,
          }),
        ],
        NOW,
      );
      expect(decision.allow).toBe(true);
      if (decision.allow) {
        expect(decision.invite.id).toBe('reissued');
        expect(decision.invite.role).toBe(APP_ROLE.Admin);
      }
    });

    it('denies when every invite is unusable', () => {
      const decision = decideInviteGate(
        [
          invite({ id: 'a', revokedAt: '2026-07-01T00:00:00.000Z' }),
          invite({ id: 'b', expiresAt: '2026-07-01T00:00:00.000Z' }),
        ],
        NOW,
      );
      expect(decision.allow).toBe(false);
    });

    it('a revoked invite cannot be rescued by a second revoked one', () => {
      const decision = decideInviteGate(
        [
          invite({ id: 'a', revokedAt: '2026-07-01T00:00:00.000Z' }),
          invite({ id: 'b', revokedAt: '2026-07-02T00:00:00.000Z' }),
        ],
        NOW,
      );
      expect(decision).toEqual({ allow: false, reason: GATE_DENIAL.Revoked });
    });
  });

  describe('invites may or may not bind a member record', () => {
    it('supports an invite with no member link, for board members', () => {
      const decision = decideInviteGate([invite({ memberId: null })], NOW);
      expect(decision.allow).toBe(true);
      if (decision.allow) expect(decision.invite.memberId).toBeNull();
    });
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims, so casing cannot bypass the gate', () => {
    expect(normalizeEmail('  Student@FairportSchools.ORG ')).toBe(
      'student@fairportschools.org',
    );
  });
});
