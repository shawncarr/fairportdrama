import { describe, expect, it } from 'vitest';
import { markdownToPlainText, renderMarkdown } from './markdown';
import { RICH_TEXT_PROFILE } from './rich-text';

describe('ordinary formatting', () => {
  it('renders paragraphs', () => {
    expect(renderMarkdown('Hello there.')).toContain('<p>Hello there.</p>');
  });

  it('renders headings', () => {
    expect(renderMarkdown('## Auditions')).toContain('<h2>Auditions</h2>');
  });

  it('renders emphasis', () => {
    const html = renderMarkdown('**bold** and *italic*');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  it('renders lists', () => {
    const html = renderMarkdown('- one\n- two');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<li>two</li>');
  });

  it('renders blockquotes and code', () => {
    expect(renderMarkdown('> quoted')).toContain('<blockquote>');
    expect(renderMarkdown('`code`')).toContain('<code>');
  });

  it('treats single newlines as line breaks, which is what authors expect', () => {
    expect(renderMarkdown('line one\nline two')).toContain('<br>');
  });
});

describe('raw HTML in the source is neutralised', () => {
  // The core guarantee. Escaping before parsing means author-written HTML can
  // never become markup, so no sanitizer is required afterwards.
  it('renders a script tag as text, not as a script', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('neutralises an img with an inline handler', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    // The handler text may survive as inert content; what must not exist is a
    // real img element carrying it.
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).toContain('&lt;img');
  });

  it('neutralises an iframe', () => {
    expect(renderMarkdown('<iframe src="https://evil.example"></iframe>')).not.toContain(
      '<iframe',
    );
  });

  it('neutralises event handlers on a plain element', () => {
    const html = renderMarkdown('<div onclick="steal()">click</div>');
    expect(html).not.toMatch(/<div[^>]*onclick/i);
    expect(html).toContain('&lt;div');
  });

  it('neutralises a style block', () => {
    expect(renderMarkdown('<style>body{display:none}</style>')).not.toContain('<style>');
  });
});

describe('link URLs are filtered by scheme', () => {
  it('allows http and https', () => {
    expect(renderMarkdown('[x](https://example.com)')).toContain(
      'href="https://example.com/"',
    );
  });

  it('allows mailto', () => {
    expect(renderMarkdown('[mail](mailto:a@b.com)')).toContain('href="mailto:a@b.com"');
  });

  it('allows relative and anchor links', () => {
    expect(renderMarkdown('[shows](/shows/past)')).toContain('href="/shows/past"');
    expect(renderMarkdown('[top](#top)')).toContain('href="#top"');
  });

  // marked will emit whatever href it is given, so this has to be filtered.
  it('strips a javascript: link, keeping the text', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('click me');
  });

  it('strips a data: link', () => {
    const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)');
    expect(html).not.toContain('data:text/html');
  });

  it('strips a vbscript: link', () => {
    expect(renderMarkdown('[x](vbscript:msgbox)')).not.toContain('vbscript:');
  });

  it('is not fooled by leading whitespace or casing', () => {
    expect(renderMarkdown('[x](  JaVaScRiPt:alert(1))')).not.toMatch(/javascript:/i);
  });

  // marked 18 hands the link hook its text unparsed, so text written between
  // the brackets never passed through the html hook.
  it('neutralises raw HTML inside the link text', () => {
    const html = renderMarkdown('[<img src=x onerror=alert(1)>](https://example.com)');
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).toContain('&lt;img');
  });

  it('neutralises raw HTML inside the text of a refused link', () => {
    const html = renderMarkdown('[<img src=x onerror=alert(1)>](javascript:x)');
    expect(html).not.toMatch(/<img[^>]*onerror/i);
  });

  it('neutralises raw HTML inside a reference link', () => {
    const html = renderMarkdown('[<b onclick="x()">hi</b>][r]\n\n[r]: https://example.com');
    expect(html).not.toMatch(/<b[^>]*onclick/i);
  });

  it('renders formatting inside link text', () => {
    expect(renderMarkdown('[**bold**](https://example.com)')).toContain('<strong>bold</strong>');
  });

  // Browsers read these as another host, so they must not pass as relative
  // links, which get no rel attribute.
  it.each(['//evil.example', '/\\evil.example', '/\t/evil.example'])(
    'refuses the host-relative link %j',
    (href) => {
      expect(renderMarkdown(`[x](<${href}>)`)).not.toContain('<a');
    },
  );

  it('still allows a root-relative path', () => {
    expect(renderMarkdown('[x](/shows)')).toContain('href="/shows"');
  });

  it('opens external links without handing over a window reference', () => {
    const html = renderMarkdown('[x](https://example.com)');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('does not add target to internal links', () => {
    expect(renderMarkdown('[x](/shows/past)')).not.toContain('target="_blank"');
  });
});

describe('image URLs are filtered the same way', () => {
  it('allows an https image', () => {
    expect(renderMarkdown('![alt](https://example.com/a.png)')).toContain('<img');
  });

  it('strips a javascript: image source', () => {
    expect(renderMarkdown('![alt](javascript:alert(1))')).not.toContain('javascript:');
  });

  it('cannot break out of the alt attribute', () => {
    const html = renderMarkdown('![" onerror="alert(1)](https://example.com/a.png)');
    // The img tag must carry exactly one attribute boundary - no injected
    // onerror outside the quoted alt value.
    expect(html).not.toMatch(/<img[^>]*"\s+onerror=/i);
  });
});

describe('edge cases', () => {
  it('handles empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('preserves ampersands as text rather than breaking entities', () => {
    expect(renderMarkdown('Rosencrantz & Guildenstern')).toContain(
      'Rosencrantz &amp; Guildenstern',
    );
  });

  it('handles apostrophes in show titles', () => {
    expect(renderMarkdown("Charlotte's Web")).toContain('Charlotte');
  });
});

describe('the basic profile, used for bios', () => {
  const basic = (source: string) =>
    renderMarkdown(source, { profile: RICH_TEXT_PROFILE.Basic });

  it('keeps emphasis, links, lists, and line breaks', () => {
    const html = basic('**bold** *it* [x](https://x.example)\nnext\n\n- one');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>it</em>');
    expect(html).toContain('href="https://x.example/"');
    expect(html).toContain('<br>');
    expect(html).toContain('<li>one</li>');
  });

  it.each([
    ['# Big news', '# Big news', '<h1'],
    ['Title\n---', 'Title<br>---', '<h2'],
    ['> quoted', '&gt; quoted', '<blockquote'],
    ['```\n<x>\n```', '```<br>&lt;x&gt;<br>```', '<pre'],
    ['| a |\n|---|\n| 1 |', '| a |', '<table'],
    ['---', '<p>---</p>', '<hr'],
    ['![a](https://x.example/i.png)', '![a](https://x.example/i.png)', '<img'],
    ['`c`', '`c`', '<code'],
    ['~~d~~', '~~d~~', '<del'],
  ])('shows %j as the text that was typed', (source, visible, forbidden) => {
    const html = basic(source);
    expect(html).toContain(visible);
    expect(html).not.toContain(forbidden);
  });

  it('still neutralises raw HTML', () => {
    expect(basic('<script>alert(1)</script>')).not.toContain('<script>');
  });

  it('neutralises raw HTML inside link text', () => {
    expect(basic('[<img src=x onerror=alert(1)>](https://x.example)')).not.toMatch(/<img[^>]*onerror/i);
  });

  it('shows an image inside a link as the text that was typed', () => {
    const html = basic('[![a](https://x.example/i.png)](https://x.example)');
    expect(html).not.toContain('<img');
    expect(html).toContain('![a](https://x.example/i.png)');
  });

  it('shows a task list checkbox as text, not an input', () => {
    const html = basic('- [ ] learn lines\n- [x] audition');
    expect(html).not.toContain('<input');
    expect(html).toContain('[ ] learn lines');
    expect(html).toContain('[x] audition');
  });

  it('keeps an escaped block in its own paragraph', () => {
    expect(basic('# Hi\n\nAfter')).toMatch(/<p># Hi<\/p>\s*<p>After<\/p>/);
  });
});

describe('the full profile is the default', () => {
  it('renders headings without being asked', () => {
    expect(renderMarkdown('## Auditions')).toContain('<h2>Auditions</h2>');
  });
});

describe('markdownToPlainText', () => {
  it.each([
    ['A **demigod** quest [across](https://x.example) *America*.', 'A demigod quest across America.'],
    ['## Head\n\nBody\n- a\n- b', 'Head Body a b'],
    ['**b**old 5 \\* 3 my\\_var', 'bold 5 * 3 my_var'],
    ['<b>x</b> & y', 'x & y'],
    ['line\nline2', 'line line2'],
    // The editor saves & and < as entities; plain text is escaped again on output.
    ['Rock &amp; Roll &lt;3 &quot;live&quot; it&#39;s &#x41;', 'Rock & Roll <3 "live" it\'s A'],
  ])('turns %j into %j', (source, plain) => {
    expect(markdownToPlainText(source)).toBe(plain);
  });

  it('leaves an out-of-range character reference as written rather than throwing', () => {
    expect(markdownToPlainText('big &#99999999; &#x110000;')).toBe('big &#99999999; &#x110000;');
  });
});
