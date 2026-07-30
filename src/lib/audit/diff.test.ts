import { describe, expect, it } from 'vitest';
import { buildDiff, isEmptyDiff } from './diff';

describe('buildDiff', () => {
  it('records a changed field as before/after', () => {
    const before = { bio: 'old', name: 'Daniel' };
    const after = { bio: 'new', name: 'Daniel' };
    expect(buildDiff(before, after, { bio: 'new' })).toEqual({
      bio: { before: 'old', after: 'new' },
    });
  });

  // The central property. Iterating the model would surface fields the caller
  // never touched - including ones differing only through defaulting or
  // serialization - and attribute them to this edit.
  it('ignores fields that differ but were not in the patch', () => {
    const before = { bio: 'old', updatedAt: 'monday' };
    const after = { bio: 'new', updatedAt: 'tuesday' };
    const diff = buildDiff(before, after, { bio: 'new' });
    expect(diff).toEqual({ bio: { before: 'old', after: 'new' } });
    expect(diff).not.toHaveProperty('updatedAt');
  });

  it('drops patch keys whose value did not actually change', () => {
    const before = { bio: 'same', visibility: 'limited' };
    const after = { bio: 'same', visibility: 'full' };
    expect(buildDiff(before, after, { bio: 'same', visibility: 'full' })).toEqual({
      visibility: { before: 'limited', after: 'full' },
    });
  });

  it('produces an empty diff when a submitted edit changes nothing', () => {
    const row = { bio: 'unchanged' };
    const diff = buildDiff(row, row, { bio: 'unchanged' });
    expect(diff).toEqual({});
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it('distinguishes null from undefined from empty string', () => {
    expect(
      buildDiff(
        { bio: null } as Record<string, unknown>,
        { bio: '' } as Record<string, unknown>,
        { bio: '' },
      ),
    ).toEqual({ bio: { before: null, after: '' } });

    expect(
      buildDiff(
        { bio: undefined } as Record<string, unknown>,
        { bio: null } as Record<string, unknown>,
        { bio: null },
      ),
    ).toEqual({ bio: { before: undefined, after: null } });
  });

  it('treats clearing a field as a real change', () => {
    expect(
      buildDiff(
        { photoImageId: 'img_123' } as Record<string, unknown>,
        { photoImageId: null } as Record<string, unknown>,
        { photoImageId: null },
      ),
    ).toEqual({ photoImageId: { before: 'img_123', after: null } });
  });

  describe('structural comparison', () => {
    it('does not report reordered-but-equal arrays as unchanged incorrectly', () => {
      // Order is meaningful for these values, so a reorder IS a change.
      expect(
        buildDiff({ roles: ['actor', 'crew'] }, { roles: ['crew', 'actor'] }, {
          roles: ['crew', 'actor'],
        }),
      ).toEqual({
        roles: { before: ['actor', 'crew'], after: ['crew', 'actor'] },
      });
    });

    it('treats identical arrays as unchanged', () => {
      expect(
        buildDiff({ roles: ['actor'] }, { roles: ['actor'] }, { roles: ['actor'] }),
      ).toEqual({});
    });

    it('treats identical nested objects as unchanged', () => {
      const shape = { images: { poster: 'a', hero: 'b' } };
      expect(buildDiff(shape, structuredClone(shape), { images: shape.images })).toEqual(
        {},
      );
    });

    it('detects a change nested inside an object', () => {
      expect(
        buildDiff(
          { images: { poster: 'a' } },
          { images: { poster: 'b' } },
          { images: { poster: 'b' } },
        ),
      ).toEqual({
        images: { before: { poster: 'a' }, after: { poster: 'b' } },
      });
    });

    it('does not confuse an array with an object', () => {
      expect(
        buildDiff(
          { v: [] } as Record<string, unknown>,
          { v: {} } as Record<string, unknown>,
          { v: {} },
        ),
      ).toEqual({ v: { before: [], after: {} } });
    });

    it('detects added and removed object keys', () => {
      expect(
        buildDiff({ v: { a: 1 } }, { v: { a: 1, b: 2 } }, { v: { a: 1, b: 2 } }),
      ).toEqual({ v: { before: { a: 1 }, after: { a: 1, b: 2 } } });
    });
  });

  it('handles an empty patch', () => {
    expect(buildDiff({ a: 1 }, { a: 2 }, {})).toEqual({});
  });
});
