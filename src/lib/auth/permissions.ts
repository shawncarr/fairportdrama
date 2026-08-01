import { APP_ROLE, type AppRole } from '~/db/schema/governance';

/**
 * Resource/action statement.
 *
 * Every authorization decision resolves against this table rather than an
 * inline role comparison. `if (role === 'admin')` scattered through routes is
 * how permission drift starts.
 */
export const STATEMENT = {
  show: ['create', 'update', 'delete'],
  cast: ['assign'],
  news: ['create', 'update', 'publish', 'delete'],
  member: ['create', 'update', 'delete'],
  memberSelf: ['update', 'setVisibility'],
  memberEdit: ['approve'],
  sponsor: ['manage'],
  spiritwear: ['manage'],
  account: ['invite', 'assignRole', 'revoke', 'link'],
  audit: ['readAll', 'readOwn'],
} as const;

export type Resource = keyof typeof STATEMENT;
export type Action<R extends Resource> = (typeof STATEMENT)[R][number];

type RoleGrants = { [R in Resource]?: readonly Action<R>[] };

/**
 * Role definitions.
 *
 * Deliberately not named "Advisor": in a high school context that reads as the
 * faculty advisor to the club, who is not a participant in this system.
 * `staff` covers adults affiliated with the club who are not board members.
 */
const GRANTS: Record<AppRole, RoleGrants> = {
  // Booster Club board members. The only role that manages accounts.
  [APP_ROLE.Admin]: {
    show: ['create', 'update', 'delete'],
    cast: ['assign'],
    news: ['create', 'update', 'publish', 'delete'],
    member: ['create', 'update', 'delete'],
    memberSelf: ['update', 'setVisibility'],
    memberEdit: ['approve'],
    sponsor: ['manage'],
    spiritwear: ['manage'],
    account: ['invite', 'assignRole', 'revoke', 'link'],
    audit: ['readAll', 'readOwn'],
  },

  // Adults affiliated with the club who are not board members: directors,
  // teachers, parent volunteers. Everything except account management.
  [APP_ROLE.Staff]: {
    show: ['create', 'update', 'delete'],
    cast: ['assign'],
    news: ['create', 'update', 'publish', 'delete'],
    member: ['create', 'update', 'delete'],
    memberSelf: ['update', 'setVisibility'],
    memberEdit: ['approve'],
    sponsor: ['manage'],
    spiritwear: ['manage'],
    audit: ['readAll', 'readOwn'],
  },

  // Drama Club student officers.
  //
  // Holds memberEdit.approve by explicit decision: officers can clear the
  // approval queue without waiting on an adult, with the audit log as the
  // accountability mechanism rather than an adult gate. The residual risk -
  // students approving each other's public bios - is accepted and documented.
  // Revoking it is a one-line change here.
  [APP_ROLE.Officer]: {
    cast: ['assign'],
    news: ['create', 'update', 'publish', 'delete'],
    member: ['create', 'update'],
    memberSelf: ['update', 'setVisibility'],
    memberEdit: ['approve'],
    audit: ['readOwn'],
  },

  // Any student with an account.
  [APP_ROLE.Member]: {
    memberSelf: ['update', 'setVisibility'],
    audit: ['readOwn'],
  },
};

/**
 * A user with no role - an account that exists but has not been granted
 * access. Under invite-only signup this should not occur, but it must fail
 * closed if it ever does.
 */
export const NO_ROLE_GRANTS: RoleGrants = {};

export function can<R extends Resource>(
  role: AppRole | null,
  resource: R,
  action: Action<R>,
): boolean {
  if (role === null) return false;
  const grants = GRANTS[role] ?? NO_ROLE_GRANTS;
  const actions = grants[resource];
  return actions !== undefined && (actions as readonly string[]).includes(action);
}

/**
 * Fields a member may change on their own profile.
 *
 * Split by whether the change reaches the public site as content. Flipping
 * visibility only reveals a bio and photo that already passed review, so the
 * toggle is not the risky action - the content is.
 */
export const SELF_EDIT_FIELDS = {
  /** Applies immediately. */
  immediate: ['visibility'],
  /** Queues in pending_edits for approval. */
  requiresApproval: ['bio', 'photoImageId', 'instagram'],
} as const;

/** Roster data. Not self-editable at any visibility level. */
export const ROSTER_FIELDS = ['name', 'grade', 'graduationYear'] as const;

export type SelfEditableField =
  | (typeof SELF_EDIT_FIELDS.immediate)[number]
  | (typeof SELF_EDIT_FIELDS.requiresApproval)[number];

export function isSelfEditable(field: string): field is SelfEditableField {
  return (
    (SELF_EDIT_FIELDS.immediate as readonly string[]).includes(field) ||
    (SELF_EDIT_FIELDS.requiresApproval as readonly string[]).includes(field)
  );
}

/**
 * Whether a proposed self-edit has to be reviewed before it takes effect.
 *
 * Clearing an approval-gated field is immediate. Approval exists to review what
 * a student publishes, not to slow down taking it back: requiring an officer to
 * sign off on removing a photo would leave a student who is uncomfortable with
 * their own photo waiting on someone else to take it down. That is the same
 * reasoning that makes the visibility toggle free in both directions.
 */
export function selfEditNeedsApproval(field: string, value: unknown): boolean {
  if (!(SELF_EDIT_FIELDS.requiresApproval as readonly string[]).includes(field)) return false;
  return value !== null && value !== '';
}
