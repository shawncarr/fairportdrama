import { describe, expect, it } from 'vitest';
import { generateId } from './id';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('generateId', () => {
  it('produces a well-formed UUID with version 7 and the RFC 9562 variant', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateId()).toMatch(UUID_RE);
    }
  });

  it('is unique across many calls at the same millisecond', () => {
    const now = 1_800_000_000_000;
    const ids = new Set(Array.from({ length: 5000 }, () => generateId(now)));
    expect(ids.size).toBe(5000);
  });

  // The reason v7 was chosen: ORDER BY id on audit_events is equivalent to
  // ORDER BY created_at, with no second index and stable keyset pagination.
  it('sorts lexicographically in timestamp order', () => {
    const times = [
      1_700_000_000_000, 1_700_000_000_001, 1_700_000_001_000, 1_800_000_000_000,
      1_900_000_000_000,
    ];
    const ids = times.map((t) => generateId(t));
    expect([...ids].sort()).toEqual(ids);
  });

  it('encodes the timestamp in the leading 48 bits', () => {
    const now = 1_800_000_000_000;
    const hex = generateId(now).replace(/-/g, '').slice(0, 12);
    expect(parseInt(hex, 16)).toBe(now);
  });

  it('orders ids from sequential milliseconds correctly', () => {
    const base = Date.now();
    const ids = Array.from({ length: 100 }, (_, i) => generateId(base + i));
    expect([...ids].sort()).toEqual(ids);
  });
});
