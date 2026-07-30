const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
};

/**
 * Escapes user-supplied text for interpolation into hand-built HTML.
 *
 * Ported from the Astro site's contact route. Needed only for email bodies,
 * which are assembled as strings; JSX escapes its own interpolations.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);
}
