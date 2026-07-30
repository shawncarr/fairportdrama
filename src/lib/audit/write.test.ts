import { describe, expect, it } from 'vitest';
import { AUDIT_ACTOR_KIND, systemActor, type Actor } from './actor';
import { AUDIT_ACTION, AUDIT_ENTITY_KIND } from './constants';
import { buildAuditRow } from './write';

const NOW = new Date('2026-07-30T12:00:00.000Z');

const userActor: Actor = {
  kind: AUDIT_ACTOR_KIND.User,
  id: 'user_123',
  label: 'Daniel Doser',
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
};

describe('buildAuditRow', () => {
  it('records the actor, action, and target', () => {
    const row = buildAuditRow(
      userActor,
      {
        action: AUDIT_ACTION.MemberUpdated,
        targetKind: AUDIT_ENTITY_KIND.Member,
        targetId: 'daniel-doser',
      },
      NOW,
    );

    expect(row).toMatchObject({
      actorKind: 'user',
      actorUserId: 'user_123',
      actorLabel: 'Daniel Doser',
      action: 'Member.Updated',
      targetKind: 'member',
      targetId: 'daniel-doser',
    });
  });

  it('stamps origin time, not insert time', () => {
    const row = buildAuditRow(
      userActor,
      {
        action: AUDIT_ACTION.MemberUpdated,
        targetKind: AUDIT_ENTITY_KIND.Member,
        targetId: 'x',
      },
      NOW,
    );
    expect(row.createdAt).toBe('2026-07-30T12:00:00.000Z');
  });

  it('derives a sortable id from the same timestamp', () => {
    const earlier = buildAuditRow(
      userActor,
      { action: AUDIT_ACTION.MemberUpdated, targetKind: 'member', targetId: 'x' },
      new Date('2026-07-30T12:00:00.000Z'),
    );
    const later = buildAuditRow(
      userActor,
      { action: AUDIT_ACTION.MemberUpdated, targetKind: 'member', targetId: 'x' },
      new Date('2026-07-30T12:00:01.000Z'),
    );
    expect(earlier.id < later.id).toBe(true);
  });

  describe('actor attribution', () => {
    // The defect this design exists to prevent: a row claiming a user actor
    // while carrying no user id, which reads as "someone did this" but names
    // nobody.
    it('never records a user kind with a null id', () => {
      const row = buildAuditRow(
        systemActor('198.51.100.1', 'cron'),
        { action: AUDIT_ACTION.MemberUpdated, targetKind: 'member', targetId: 'x' },
        NOW,
      );
      expect(row.actorKind).toBe('system');
      expect(row.actorUserId).toBeNull();
    });

    it('nulls the user id when the actor is not a user, even if one is present', () => {
      const contradictory: Actor = {
        kind: AUDIT_ACTOR_KIND.System,
        id: 'user_should_be_ignored',
        label: null,
        ip: null,
        userAgent: null,
      };
      const row = buildAuditRow(
        contradictory,
        { action: AUDIT_ACTION.MemberUpdated, targetKind: 'member', targetId: 'x' },
        NOW,
      );
      expect(row.actorKind).toBe('system');
      expect(row.actorUserId).toBeNull();
    });

    it('carries ip and user agent from the actor', () => {
      const row = buildAuditRow(
        userActor,
        { action: AUDIT_ACTION.MemberUpdated, targetKind: 'member', targetId: 'x' },
        NOW,
      );
      expect(row.ip).toBe('203.0.113.7');
      expect(row.userAgent).toBe('Mozilla/5.0');
    });
  });

  describe('payload and diff are distinct', () => {
    it('defaults both to null so neither is implicitly an empty object', () => {
      const row = buildAuditRow(
        userActor,
        { action: AUDIT_ACTION.MemberCreated, targetKind: 'member', targetId: 'x' },
        NOW,
      );
      expect(row.payload).toBeNull();
      expect(row.diff).toBeNull();
    });

    it('carries a diff for an update without inventing a payload', () => {
      const row = buildAuditRow(
        userActor,
        {
          action: AUDIT_ACTION.MemberUpdated,
          targetKind: 'member',
          targetId: 'x',
          diff: { bio: { before: 'a', after: 'b' } },
        },
        NOW,
      );
      expect(row.diff).toEqual({ bio: { before: 'a', after: 'b' } });
      expect(row.payload).toBeNull();
    });

    it('carries a payload for a create without inventing a diff', () => {
      const row = buildAuditRow(
        userActor,
        {
          action: AUDIT_ACTION.MemberCreated,
          targetKind: 'member',
          targetId: 'x',
          payload: { name: 'Daniel Doser' },
        },
        NOW,
      );
      expect(row.payload).toEqual({ name: 'Daniel Doser' });
      expect(row.diff).toBeNull();
    });
  });

  it('defaults relatedEntities to an empty array, never null', () => {
    const row = buildAuditRow(
      userActor,
      { action: AUDIT_ACTION.MemberUpdated, targetKind: 'member', targetId: 'x' },
      NOW,
    );
    expect(row.relatedEntities).toEqual([]);
  });

  it('carries related entities for a cast assignment', () => {
    const row = buildAuditRow(
      userActor,
      {
        action: AUDIT_ACTION.ShowCastAssigned,
        targetKind: AUDIT_ENTITY_KIND.ShowCast,
        targetId: 'cast_1',
        relatedEntities: [
          { kind: AUDIT_ENTITY_KIND.Show, id: 'the-lightning-thief-2026' },
          { kind: AUDIT_ENTITY_KIND.Member, id: 'daniel-doser' },
        ],
      },
      NOW,
    );
    expect(row.relatedEntities).toHaveLength(2);
  });
});
