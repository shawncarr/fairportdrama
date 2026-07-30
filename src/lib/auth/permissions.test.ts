import { describe, expect, it } from 'vitest';
import { APP_ROLE, type AppRole } from '~/db/schema/governance';
import {
  STATEMENT,
  can,
  isSelfEditable,
  selfEditNeedsApproval,
  type Resource,
} from './permissions';

const ROLES: AppRole[] = [
  APP_ROLE.Admin,
  APP_ROLE.Staff,
  APP_ROLE.Officer,
  APP_ROLE.Member,
];

/** Every "resource.action" string the statement defines. */
const ALL_PERMISSIONS: string[] = Object.entries(STATEMENT).flatMap(
  ([resource, actions]) => (actions as readonly string[]).map((a) => `${resource}.${a}`),
);

const granted = (role: AppRole | null): string[] =>
  ALL_PERMISSIONS.filter((p) => {
    const [resource, action] = p.split('.') as [Resource, never];
    return can(role, resource, action);
  });

describe('permission matrix', () => {
  // Written out in full rather than derived. A change to GRANTS must be
  // mirrored here deliberately, which is the point: this file is the
  // human-readable spec of who can do what.
  it('admin holds every permission in the statement', () => {
    expect(granted(APP_ROLE.Admin).sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('staff holds everything except account management', () => {
    expect(granted(APP_ROLE.Staff).sort()).toEqual(
      ALL_PERMISSIONS.filter((p) => !p.startsWith('account.')).sort(),
    );
  });

  it('officer holds content permissions but not shows, sponsors, or merch', () => {
    expect(granted(APP_ROLE.Officer).sort()).toEqual(
      [
        'audit.readOwn',
        'cast.assign',
        'member.create',
        'member.update',
        'memberEdit.approve',
        'memberSelf.setVisibility',
        'memberSelf.update',
        'news.create',
        'news.delete',
        'news.publish',
        'news.update',
      ].sort(),
    );
  });

  it('member holds only self-service permissions', () => {
    expect(granted(APP_ROLE.Member).sort()).toEqual(
      ['audit.readOwn', 'memberSelf.setVisibility', 'memberSelf.update'].sort(),
    );
  });
});

describe('fail-closed behaviour', () => {
  it('grants nothing to a user with no role', () => {
    expect(granted(null)).toEqual([]);
  });

  it('grants nothing for an unrecognised role', () => {
    expect(can('nonsense' as AppRole, 'news', 'create')).toBe(false);
  });

  it('denies an action that is not in the statement for that resource', () => {
    expect(can(APP_ROLE.Admin, 'audit', 'delete' as never)).toBe(false);
  });
});

describe('privilege boundaries that matter', () => {
  it('only admin can manage accounts', () => {
    for (const role of ROLES) {
      expect(can(role, 'account', 'invite')).toBe(role === APP_ROLE.Admin);
      expect(can(role, 'account', 'assignRole')).toBe(role === APP_ROLE.Admin);
    }
  });

  it('students cannot delete members, and cannot touch shows or sponsors', () => {
    expect(can(APP_ROLE.Officer, 'member', 'delete')).toBe(false);
    expect(can(APP_ROLE.Officer, 'show', 'create')).toBe(false);
    expect(can(APP_ROLE.Officer, 'sponsor', 'manage')).toBe(false);
    expect(can(APP_ROLE.Officer, 'spiritwear', 'manage')).toBe(false);
  });

  it('a plain member cannot approve anyone, including themselves', () => {
    expect(can(APP_ROLE.Member, 'memberEdit', 'approve')).toBe(false);
  });

  it('officers CAN approve member edits - an accepted, documented risk', () => {
    // Explicit product decision: accountability via the audit log rather than
    // an adult gate. Asserted so that revoking it is a visible test change,
    // not a silent behaviour drift.
    expect(can(APP_ROLE.Officer, 'memberEdit', 'approve')).toBe(true);
  });

  it('only adults can read the full audit log', () => {
    expect(can(APP_ROLE.Admin, 'audit', 'readAll')).toBe(true);
    expect(can(APP_ROLE.Staff, 'audit', 'readAll')).toBe(true);
    expect(can(APP_ROLE.Officer, 'audit', 'readAll')).toBe(false);
    expect(can(APP_ROLE.Member, 'audit', 'readAll')).toBe(false);
  });
});

describe('member self-edit field rules', () => {
  it('visibility applies immediately without approval', () => {
    expect(isSelfEditable('visibility')).toBe(true);
    expect(selfEditNeedsApproval('visibility')).toBe(false);
  });

  it('published content queues for approval', () => {
    for (const field of ['bio', 'photoImageId', 'instagram']) {
      expect(isSelfEditable(field)).toBe(true);
      expect(selfEditNeedsApproval(field)).toBe(true);
    }
  });

  it('roster fields are not self-editable at all', () => {
    for (const field of ['name', 'grade', 'graduationYear']) {
      expect(isSelfEditable(field)).toBe(false);
    }
  });

  it('unknown fields are not self-editable', () => {
    expect(isSelfEditable('isOfficer')).toBe(false);
    expect(isSelfEditable('officerTitle')).toBe(false);
    expect(isSelfEditable('__proto__')).toBe(false);
  });
});
