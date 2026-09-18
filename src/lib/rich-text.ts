import { Marked } from 'marked';

/**
 * What a rich text field may contain.
 *
 * Shared by the server renderer and the admin editor, so the editor never
 * offers formatting the public page would refuse to render. `basic` is for
 * member bios, which students write; `full` is for news and synopses.
 */
export const RICH_TEXT_PROFILE = { Full: 'full', Basic: 'basic' } as const;
export type RichTextProfile = (typeof RICH_TEXT_PROFILE)[keyof typeof RICH_TEXT_PROFILE];

/** The bio and synopsis limit, counted in markdown source, as the server stores it. */
export const RICH_TEXT_MAX_LENGTH = 2000;

const BASIC_TOKENS = new Set([
  'space',
  'paragraph',
  'text',
  'strong',
  'em',
  'link',
  'br',
  'escape',
  'list',
  'list_item',
]);

const FULL_TOKENS = new Set([
  ...BASIC_TOKENS,
  'heading',
  'blockquote',
  'code',
  'codespan',
  'hr',
  'image',
  'del',
]);

const lexer = new Marked({ gfm: true, breaks: true });

/**
 * The first markdown construct in `source` that `profile` does not model, or
 * null if it has none.
 *
 * The editor must not mount on such a source: Tiptap loads a document holding
 * an unregistered node as empty, and saving would erase the field.
 */
export function unsupportedToken(source: string, profile: RichTextProfile): string | null {
  const allowed = profile === RICH_TEXT_PROFILE.Basic ? BASIC_TOKENS : FULL_TOKENS;
  let found: string | null = null;
  lexer.walkTokens(lexer.lexer(source), (token) => {
    if (found === null && !allowed.has(token.type)) found = token.type;
  });
  return found;
}

const SAFE_SCHEMES = ['http:', 'https:', 'mailto:'];

/** The URL if its scheme is safe to link to, else null. */
export function safeUrl(href: string): string | null {
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
