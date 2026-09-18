import { describe, expect, it } from 'vitest';
import { RICH_TEXT_PROFILE, safeUrl, unsupportedToken } from './rich-text';

const { Basic, Full } = RICH_TEXT_PROFILE;

describe('unsupportedToken', () => {
  it('accepts what a bio may contain', () => {
    const bio = 'Playing **Percy**, *finally*.\nSee [the show](https://x.example).\n\n- one\n- two\n\n1. a\n2. b';
    expect(unsupportedToken(bio, Basic)).toBeNull();
  });

  it('accepts the entities the editor writes back unchanged', () => {
    expect(unsupportedToken('Tom &amp; Jerry &lt;3 &gt; &quot;hi&quot;', Basic)).toBeNull();
  });

  it('accepts a tight list and a link without an image', () => {
    expect(unsupportedToken('- a\n- b\n\n[x](https://x.example)', Basic)).toBeNull();
  });

  it('accepts plain prose with literal markdown characters', () => {
    expect(unsupportedToken('5 * 3 and my_var #1', Basic)).toBeNull();
  });

  it.each([
    ['# Hi', 'heading'],
    ['Title\n---', 'heading'],
    ['> quoted', 'blockquote'],
    ['`code`', 'codespan'],
    ['```\ncode\n```', 'code'],
    ['---', 'hr'],
    ['![alt](https://x.example/a.png)', 'image'],
    ['~~gone~~', 'del'],
  ])('refuses %j in a bio', (source, type) => {
    expect(unsupportedToken(source, Basic)).toBe(type);
  });

  it('accepts everything the full editor models', () => {
    const post = '## Head\n\n> q\n\n`c` ~~d~~ ![i](https://x.example/i.png)\n\n---\n\n```\nx\n```';
    expect(unsupportedToken(post, Full)).toBeNull();
  });

  it.each([
    ['| a |\n|---|\n| 1 |', 'table'],
    ['<b>raw</b>', 'html'],
    ['[ref][1]\n\n[1]: https://x.example', 'def'],
    // The editor re-escapes these, so caf&eacute; would publish as literal text.
    ['caf&eacute;', 'entity'],
    ['a\n\n&nbsp;\n\nb', 'entity'],
    ['[Tom &copy;](https://x.example)', 'entity'],
    // The editor drops the link around the image.
    ['[![i](https://x.example/a.png)](https://x.example)', 'linked image'],
    // The editor tightens the spacing.
    ['- a\n\n- b', 'loose list'],
  ])('refuses %j even in full', (source, type) => {
    expect(unsupportedToken(source, Full)).toBe(type);
  });
});

describe('safeUrl', () => {
  it('keeps http, https, mailto, relative, and anchors', () => {
    expect(safeUrl('https://x.example')).toBe('https://x.example/');
    expect(safeUrl('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(safeUrl('/shows')).toBe('/shows');
    expect(safeUrl('#cast')).toBe('#cast');
  });

  it('refuses links a browser would send to another host', () => {
    expect(safeUrl('//evil.example')).toBeNull();
    expect(safeUrl('/\\evil.example')).toBeNull();
    expect(safeUrl('/\t/evil.example')).toBeNull();
  });

  it('refuses javascript and junk', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
  });
});
