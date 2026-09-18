import { Marked, type RendererObject, type Token, type Tokens } from 'marked';
import { escapeHtml } from '~/lib/html';
import { RICH_TEXT_PROFILE, type RichTextProfile, safeUrl } from '~/lib/rich-text';

/**
 * Renders news post bodies, show synopses, and member bios.
 *
 * The input is untrusted (students write it) and the output goes on a public
 * page. The usual answer - render, then sanitize with DOMPurify - is
 * unavailable: DOMPurify needs a DOM and this runs in workerd.
 *
 * Instead the renderer itself is closed off. Markdown parses normally, but the
 * hooks that would emit author-written HTML escape it instead, and link and
 * image URLs are filtered by scheme. The output can only contain markup marked
 * generated, so there is nothing left for a sanitizer to remove.
 *
 * An earlier version escaped the whole source before parsing. That was safe but
 * too blunt: it also escaped markdown's own syntax, so `> quoted` stopped
 * producing a blockquote and quotes came out double-escaped.
 *
 * Bios use the `basic` profile: everything outside `src/lib/rich-text.ts`'s
 * basic set renders as the text the author typed, in its own paragraph,
 * rather than as the formatting it would otherwise produce.
 */

const safe: RendererObject = {
  /**
   * Raw HTML, block-level and inline alike, is rendered as visible text
   * rather than markup. Both kinds route through this hook, which is why no
   * tokenizer override is needed - an earlier attempt to intercept inline
   * text at the tokenizer swallowed the source before marked could find
   * emphasis or line breaks in it.
   */
  html({ text }) {
    return escapeHtml(text);
  },

  link({ href, title, text }) {
    const url = safeUrl(href);
    if (!url) return text;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    // External links open in a new tab without handing the target a window
    // reference back.
    const external = url.startsWith('http');
    const rel = external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${escapeHtml(url)}"${titleAttr}${rel}>${text}</a>`;
  },

  image({ href, title, text }) {
    const url = safeUrl(href);
    if (!url) return text;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${titleAttr} loading="lazy" />`;
  },
};

/** A block the profile refuses, shown as its source in its own paragraph. */
const blockAsText = ({ raw }: { raw: string }) =>
  `<p>${escapeHtml(raw.trim()).replace(/\n/g, '<br>')}</p>\n`;
const inlineAsText = ({ raw }: { raw: string }) => escapeHtml(raw);

const full = new Marked({ gfm: true, breaks: true, renderer: safe });

const basic = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    ...safe,
    heading: blockAsText,
    blockquote: blockAsText,
    code: blockAsText,
    table: blockAsText,
    hr: blockAsText,
    image: inlineAsText,
    codespan: inlineAsText,
    del: inlineAsText,
    // A GFM task list item would otherwise render a real checkbox input.
    checkbox: ({ checked }) => (checked ? '[x] ' : '[ ] '),
  },
});

export function renderMarkdown(
  source: string,
  { profile = RICH_TEXT_PROFILE.Full }: { profile?: RichTextProfile } = {},
): string {
  const md = profile === RICH_TEXT_PROFILE.Basic ? basic : full;
  return md.parse(source, { async: false });
}

const BLOCKS = new Set(['paragraph', 'heading', 'blockquote', 'list_item']);

function plain(tokens: Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === 'list') {
        return (token as Tokens.List).items.map((item) => plain(item.tokens)).join(' ') + ' ';
      }
      if (token.type === 'table') {
        const table = token as Tokens.Table;
        return [...table.header, ...table.rows.flat()].map((cell) => plain(cell.tokens)).join(' ') + ' ';
      }
      if (token.type === 'html') return '';
      if ('tokens' in token && token.tokens) {
        return plain(token.tokens) + (BLOCKS.has(token.type) ? ' ' : '');
      }
      if (token.type === 'code') return `${(token as Tokens.Code).text} `;
      if (token.type === 'br' || token.type === 'space' || token.type === 'hr') return ' ';
      return 'text' in token ? String(token.text) : '';
    })
    .join('');
}

/**
 * The words in a markdown source, for places that need a string: meta
 * descriptions and the home page teaser. Raw HTML is dropped, not escaped,
 * because the caller escapes on output.
 */
export function markdownToPlainText(source: string): string {
  return plain(full.lexer(source)).replace(/\s+/g, ' ').trim();
}
