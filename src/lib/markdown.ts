import { Marked } from 'marked';
import { escapeHtml } from '~/lib/html';

/**
 * Renders news post bodies.
 *
 * News is written by students, so the input is untrusted and the output goes
 * on a public page. The usual answer - render, then sanitize with DOMPurify -
 * is unavailable: DOMPurify needs a DOM and this runs in workerd.
 *
 * Instead the renderer itself is closed off. Markdown parses normally, but the
 * hooks that would emit author-written HTML escape it instead, and link and
 * image URLs are filtered by scheme. The output can only contain markup marked
 * generated, so there is nothing left for a sanitizer to remove.
 *
 * An earlier version escaped the whole source before parsing. That was safe but
 * too blunt: it also escaped markdown's own syntax, so `> quoted` stopped
 * producing a blockquote and quotes came out double-escaped.
 */

const SAFE_SCHEMES = ['http:', 'https:', 'mailto:'];

function safeUrl(href: string): string | null {
  const trimmed = href.trim();

  // Relative and anchor links are fine and common in post bodies.
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed;

  try {
    const url = new URL(trimmed);
    return SAFE_SCHEMES.includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
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
  },
});

export function renderMarkdown(source: string): string {
  return marked.parse(source, { async: false });
}
