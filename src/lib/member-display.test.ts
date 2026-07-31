import { describe, expect, it } from 'vitest';
import { MEMBER_VISIBILITY } from '~/db/schema/content';
import {
  displayName,
  hasPublicProfile,
  publicBio,
  publicPhotoId,
  toPublicMember,
  type DisplayableMember,
} from './member-display';

const member = (over: Partial<DisplayableMember> = {}): DisplayableMember => ({
  id: 'daniel-doser',
  name: 'Daniel Doser',
  visibility: MEMBER_VISIBILITY.Limited,
  photoImageId: 'img_abc123',
  bio: 'A long biography.',
  instagram: 'danieldoser',
  ...over,
});

describe('displayName', () => {
  it('shows the full name when the member has opted in', () => {
    expect(displayName(member({ visibility: MEMBER_VISIBILITY.Full }))).toBe(
      'Daniel Doser',
    );
  });

  it('reduces to first name and last initial when limited', () => {
    expect(displayName(member())).toBe('Daniel D.');
  });

  // Real names from the roster. A hyphenated surname must reduce to a single
  // letter, not to a "shortened" form that still identifies the family.
  it('reduces hyphenated surnames to one initial', () => {
    expect(displayName(member({ name: 'Lani Toyama-Hoskins' }))).toBe('Lani T.');
    expect(displayName(member({ name: 'Quinn Verbridge-Day' }))).toBe('Quinn V.');
  });

  it('uses the final component for multi-part names', () => {
    expect(displayName(member({ name: 'Maria del Carmen Reyes' }))).toBe('Maria R.');
  });

  it('returns just the name when there is only one component', () => {
    expect(displayName(member({ name: 'Cher' }))).toBe('Cher');
  });

  it('tolerates extra whitespace without leaking a surname', () => {
    expect(displayName(member({ name: '  Daniel   Doser  ' }))).toBe('Daniel D.');
  });

  it('uppercases the initial regardless of source casing', () => {
    expect(displayName(member({ name: 'daniel doser' }))).toBe('daniel D.');
  });

  it('handles non-ASCII surnames by grapheme, not byte', () => {
    expect(displayName(member({ name: 'Nana Chen' }))).toBe('Nana C.');
    expect(displayName(member({ name: 'Émile Ångström' }))).toBe('Émile Å.');
  });
});

describe('hasPublicProfile', () => {
  it('is false for limited members, so no detail page exists', () => {
    expect(hasPublicProfile(member())).toBe(false);
  });

  it('is true only when the member opted in', () => {
    expect(hasPublicProfile(member({ visibility: MEMBER_VISIBILITY.Full }))).toBe(true);
  });
});

describe('withheld fields', () => {
  // The columns still hold values - the club needs the data. What changes is
  // whether it is allowed out.
  it('withholds the photo from a limited member even though it is stored', () => {
    const m = member();
    expect(m.photoImageId).toBe('img_abc123');
    expect(publicPhotoId(m)).toBeNull();
  });

  it('withholds the bio from a limited member even though it is stored', () => {
    expect(publicBio(member())).toBeNull();
  });

  it('releases both once the member opts in', () => {
    const m = member({ visibility: MEMBER_VISIBILITY.Full });
    expect(publicPhotoId(m)).toBe('img_abc123');
    expect(publicBio(m)).toBe('A long biography.');
  });
});

describe('toPublicMember', () => {
  it('emits nothing identifying for a limited member', () => {
    const pub = toPublicMember(member());
    expect(pub).toEqual({
      id: 'daniel-doser',
      name: 'Daniel D.',
      photoImageId: null,
      bio: null,
      instagram: null,
      href: null,
    });
  });

  // Guards the whole projection at once: no field may carry the surname.
  it('never contains the surname anywhere in its output when limited', () => {
    const serialized = JSON.stringify(toPublicMember(member()));
    expect(serialized).not.toContain('Doser');
  });

  it('emits the full projection with a link once opted in', () => {
    expect(toPublicMember(member({ visibility: MEMBER_VISIBILITY.Full }))).toEqual({
      id: 'daniel-doser',
      name: 'Daniel Doser',
      photoImageId: 'img_abc123',
      bio: 'A long biography.',
      instagram: 'danieldoser',
      href: '/members/daniel-doser',
    });
  });

  // The id remains the slug because cast lists need a stable key, but it must
  // never be rendered as a link for a limited member.
  it('exposes the id but no href for a limited member', () => {
    const pub = toPublicMember(member());
    expect(pub.id).toBe('daniel-doser');
    expect(pub.href).toBeNull();
  });
});
