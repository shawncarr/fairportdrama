import { describe, expect, it } from 'vitest';
import { parseList, parsePriceCents } from './catalog';

describe('parsePriceCents', () => {
  it('converts dollars to whole cents', () => {
    expect(parsePriceCents('25')).toBe(2500);
    expect(parsePriceCents('25.00')).toBe(2500);
    expect(parsePriceCents('0.99')).toBe(99);
  });

  it('does not lose a cent to floating point', () => {
    // 19.99 * 100 is 1998.9999999999998 in IEEE 754. Truncating would price
    // the item at $19.98.
    expect(parsePriceCents('19.99')).toBe(1999);
    expect(parsePriceCents('1.10')).toBe(110);
    expect(parsePriceCents('8.29')).toBe(829);
  });

  it('accepts what someone would actually type', () => {
    expect(parsePriceCents('$25.00')).toBe(2500);
    expect(parsePriceCents(' 25.00 ')).toBe(2500);
    expect(parsePriceCents('1,250')).toBe(125000);
  });

  it('rejects rather than coercing, so a typo cannot become $0.00', () => {
    for (const bad of ['', 'free', 'abc', '25.999', '-5', '2.5.0', '.']) {
      expect(parsePriceCents(bad)).toBeNull();
    }
  });
});

describe('parseList', () => {
  it('splits and trims', () => {
    expect(parseList('S, M, L')).toEqual(['S', 'M', 'L']);
    expect(parseList('Navy,Grey')).toEqual(['Navy', 'Grey']);
  });

  it('drops empty entries from trailing or doubled commas', () => {
    expect(parseList('S, M, ')).toEqual(['S', 'M']);
    expect(parseList('S,,M')).toEqual(['S', 'M']);
  });

  it('returns nothing for an empty field', () => {
    expect(parseList('')).toEqual([]);
    expect(parseList('   ')).toEqual([]);
  });
});
