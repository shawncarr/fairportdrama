import { MEMBER_VISIBILITY, type MemberVisibility } from '~/db/schema/content';

export interface DisplayableMember {
  id: string;
  name: string;
  visibility: MemberVisibility;
  photoImageId?: string | null;
  bio?: string | null;
  instagram?: string | null;
}

/**
 * How a member's name appears publicly.
 *
 * `full`    -> "Daniel Doser"
 * `limited` -> "Daniel D."
 *
 * Applied at every render site. A member who has not opted in should never
 * have their surname reach a page, an OG tag, or a JSON-LD block.
 */
export function displayName(member: Pick<DisplayableMember, 'name' | 'visibility'>): string {
  if (member.visibility === MEMBER_VISIBILITY.Full) return member.name;

  const parts = member.name.trim().split(/\s+/);
  const first = parts[0] ?? '';
  if (parts.length < 2) return first;

  // Take the initial of the final component, so hyphenated and multi-part
  // surnames ("Toyama-Hoskins", "Verbridge-Day") reduce to one letter rather
  // than leaking a full name fragment.
  const surname = parts[parts.length - 1]!;
  const initial = [...surname][0] ?? '';
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
}

/**
 * Whether a member has a public detail page.
 *
 * False for `limited`, and the reason is the URL itself: /members/<slug> puts
 * the full name in the address bar, the canonical tag, and the sitemap
 * regardless of what the page body renders. Suppressing the surname on the
 * page while still serving it at a named URL would accomplish nothing.
 */
export const hasPublicProfile = (
  member: Pick<DisplayableMember, 'visibility'>,
): boolean => member.visibility === MEMBER_VISIBILITY.Full;

/** Photos are withheld from `limited` members even though the column is set. */
export const publicPhotoId = (member: DisplayableMember): string | null =>
  member.visibility === MEMBER_VISIBILITY.Full ? (member.photoImageId ?? null) : null;

/** Bios are withheld from `limited` members even though the column is set. */
export const publicBio = (member: DisplayableMember): string | null =>
  member.visibility === MEMBER_VISIBILITY.Full ? (member.bio ?? null) : null;

/** Social links are withheld from `limited` members. */
export const publicInstagram = (member: DisplayableMember): string | null =>
  member.visibility === MEMBER_VISIBILITY.Full ? (member.instagram ?? null) : null;

/**
 * The complete public projection of a member.
 *
 * Prefer this over reading fields individually: it is the one place that
 * decides what leaves the database, so a new render site cannot accidentally
 * read `member.bio` straight from the row.
 */
export function toPublicMember(member: DisplayableMember) {
  return {
    id: member.id,
    name: displayName(member),
    photoImageId: publicPhotoId(member),
    bio: publicBio(member),
    instagram: publicInstagram(member),
    href: hasPublicProfile(member) ? `/members/${member.id}` : null,
  };
}
