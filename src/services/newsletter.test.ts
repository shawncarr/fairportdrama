import { describe, expect, it } from 'vitest';
import { normalizeEmail, toCsv } from './newsletter';

describe('normalizeEmail', () => {
  it('trims and lowercases so one address is one row', () => {
    expect(normalizeEmail('  Someone@Example.COM ')).toBe('someone@example.com');
  });
});

describe('toCsv', () => {
  it('writes a header and one line per row', () => {
    expect(toCsv([{ a: '1', b: '2' }], ['a', 'b'])).toBe('a,b\n1,2');
  });

  it('quotes fields containing a comma', () => {
    expect(toCsv([{ n: 'Doser, Daniel' }], ['n'])).toBe('n\n"Doser, Daniel"');
  });

  it('doubles embedded quotes rather than escaping them', () => {
    expect(toCsv([{ n: 'He said "hi"' }], ['n'])).toBe('n\n"He said ""hi"""');
  });

  it('quotes fields containing a newline, so a row cannot be split', () => {
    expect(toCsv([{ n: 'a\nb' }], ['n'])).toBe('n\n"a\nb"');
  });

  it('renders null and undefined as empty rather than the words', () => {
    expect(toCsv([{ a: null, b: undefined }], ['a', 'b'])).toBe('a,b\n,');
  });

  it('emits only the header for no rows', () => {
    expect(toCsv([], ['a', 'b'])).toBe('a,b');
  });

  it('ignores fields not in the column list', () => {
    expect(toCsv([{ a: '1', secret: 'x' }], ['a'])).toBe('a\n1');
  });
});
