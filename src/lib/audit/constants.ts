/**
 * Entity kinds. Used for both `target_kind` and every `relatedEntities[].kind`
 * so consumers dispatch against a single typo-free set.
 */
export const AUDIT_ENTITY_KIND = {
  Member: 'member',
  Show: 'show',
  ShowCast: 'show_cast',
  ShowCrew: 'show_crew',
  ShowPerformance: 'show_performance',
  News: 'news',
  Sponsor: 'sponsor',
  SpiritWear: 'spirit_wear',
  User: 'user',
  Invite: 'invite',
  NewsletterSubscriber: 'newsletter_subscriber',
  PendingEdit: 'pending_edit',
} as const;

export type AuditEntityKind =
  (typeof AUDIT_ENTITY_KIND)[keyof typeof AUDIT_ENTITY_KIND];

/**
 * Closed action vocabulary, `Domain.Event` in PascalCase.
 *
 * Deliberately small. Add an action when a genuinely distinct thing happens,
 * not for every route.
 */
export const AUDIT_ACTION = {
  // Members
  MemberCreated: 'Member.Created',
  MemberUpdated: 'Member.Updated',
  MemberVisibilityChanged: 'Member.VisibilityChanged',
  /** A removal request honoured: photo, bio, and surname taken down. */
  MemberInformationRemoved: 'Member.InformationRemoved',
  MemberEditSubmitted: 'Member.EditSubmitted',
  MemberEditApproved: 'Member.EditApproved',
  MemberEditRejected: 'Member.EditRejected',

  // Shows
  ShowCreated: 'Show.Created',
  ShowUpdated: 'Show.Updated',
  ShowDeleted: 'Show.Deleted',
  ShowCastAssigned: 'Show.CastAssigned',
  ShowCrewAssigned: 'Show.CrewAssigned',
  ShowPerformancesChanged: 'Show.PerformancesChanged',
  ShowGalleryChanged: 'Show.GalleryChanged',

  // News
  NewsCreated: 'News.Created',
  NewsUpdated: 'News.Updated',
  NewsPublished: 'News.Published',
  NewsUnpublished: 'News.Unpublished',
  NewsDeleted: 'News.Deleted',

  // Sponsors and merchandise
  SponsorChanged: 'Sponsor.Changed',
  SpiritWearChanged: 'SpiritWear.Changed',

  // Accounts and access
  AccountInvited: 'Account.Invited',
  AccountInviteAccepted: 'Account.InviteAccepted',
  AccountInviteRevoked: 'Account.InviteRevoked',
  AccountRoleChanged: 'Account.RoleChanged',
  AccountMemberLinked: 'Account.MemberLinked',
  AccountMemberUnlinked: 'Account.MemberUnlinked',

  // Newsletter. Public, unauthenticated mutations, so the actor is `system`
  // and the IP is the only attribution available.
  NewsletterSubscribed: 'Newsletter.Subscribed',
  NewsletterUnsubscribed: 'Newsletter.Unsubscribed',

  // Auth. Only the refusal is recorded: a successful sign-in changes nothing
  // and is already in Better Auth's session table, whereas a denial writes no
  // row at all and would otherwise leave no trace.
  AuthSignInDenied: 'Auth.SignInDenied',
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

export interface RelatedEntity {
  kind: AuditEntityKind;
  id: string;
}
