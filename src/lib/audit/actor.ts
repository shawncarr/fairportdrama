export const AUDIT_ACTOR_KIND = {
  User: 'user',
  System: 'system',
} as const;

export type AuditActorKind = (typeof AUDIT_ACTOR_KIND)[keyof typeof AUDIT_ACTOR_KIND];

export interface Actor {
  readonly kind: AuditActorKind;
  readonly id: string | null;
  readonly label: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/**
 * The actor used when no session is present. Never `{ kind: 'user', id: null }`
 * — an unattributed change is a system change, not a user change with a
 * missing id.
 */
export const systemActor = (
  ip: string | null = null,
  userAgent: string | null = null,
): Actor => ({
  kind: AUDIT_ACTOR_KIND.System,
  id: null,
  label: null,
  ip,
  userAgent,
});
