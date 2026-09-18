import { Marked, type Token, type Tokens } from 'marked';

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

/** An HTML entity other than the four the editor writes back as it found them. */
const REWRITTEN_ENTITY = /&(?!(?:amp|lt|gt|quot);)(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;

/**
 * Constructs whose token type the editor models, but which it does not save
 * back as it loaded them. Each returns its name, or null.
 */
function rewrittenOnSave(token: Token): string | null {
  // `caf&eacute;` comes back as `caf&amp;eacute;` and publishes as that text.
  if (token.type === 'text' && REWRITTEN_ENTITY.test(token.raw)) return 'entity';
  // The link around the image is dropped.
  if (token.type === 'link' && token.tokens?.some((t) => t.type === 'image')) return 'linked image';
  // The blank lines between items are removed, tightening the list.
  if (token.type === 'list' && (token as Tokens.List).loose) return 'loose list';
  return null;
}

/**
 * The first markdown construct in `source` that `profile` cannot edit without
 * changing it, or null if it has none.
 *
 * The editor must not mount on such a source: Tiptap loads a document holding
 * an unregistered node as empty, and saving would erase the field. Some
 * constructs it does register still come back altered, and saving would
 * rewrite what the author wrote.
 */
export function unsupportedToken(source: string, profile: RichTextProfile): string | null {
  const allowed = profile === RICH_TEXT_PROFILE.Basic ? BASIC_TOKENS : FULL_TOKENS;
  let found: string | null = null;
  lexer.walkTokens(lexer.lexer(source), (token) => {
    if (found !== null) return;
    found = allowed.has(token.type) ? rewrittenOnSave(token) : token.type;
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
