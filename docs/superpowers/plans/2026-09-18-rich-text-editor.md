# Rich Text Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare textareas for news bodies, show synopses, and member bios with a visual editor that stores markdown, and render synopses and bios as markdown on the public site.

**Architecture:** Markdown stays the stored format. A small shared module, `src/lib/rich-text.ts`, says what each profile (`full`, `basic`) may contain; the server renderer and the browser editor both read it. The editor is Tiptap v3 with `@tiptap/markdown`, bundled by esbuild into `public/static/editor.js`, and it progressively enhances `textarea[data-rich]` so the forms and POST handlers keep working without it.

**Tech Stack:** Hono JSX on Cloudflare Workers, D1 via Drizzle, marked 18, Tiptap 3.31, esbuild, Tailwind 4 with `@tailwindcss/typography`, Vitest (node, happy-dom, and `@cloudflare/vitest-pool-workers`).

**Spec:** `docs/superpowers/specs/2026-09-18-rich-text-editor-design.md`

---

## Before you start

Read the spec. The plan implements it; the reasons live there.

You are on branch `feat/rich-text-editor`. Commit after every task.

Test commands:

```bash
npm run test:unit         # node and happy-dom, *.test.ts
npm run test:integration  # real workerd and D1, *.workers-test.ts
npm run typecheck         # wrangler types && tsc --noEmit
```

To run one file: `npx vitest run src/lib/rich-text.test.ts` for unit tests, `npx vitest run --config vitest.workers.config.ts src/routes/rich-text.workers-test.ts` for workers tests.

### Facts established by a spike (Tiptap 3.31.3, happy-dom 20)

These were verified before writing the plan. Do not re-litigate them, but do not contradict them either.

- A single newline (`Line one\nLine two`) survives load and `getMarkdown()` unchanged.
- Tiptap does **not** emit `update` when content is loaded, so an untouched field posts its original text.
- Literal `*` and `_` in prose come back escaped (`5 \* 3`, `my\_var`). marked renders the escaped and unescaped forms identically.
- **If the source contains a node the editor's schema does not register, Tiptap loads the whole document as empty.** A `basic` editor given `# Hi` shows nothing, and saving would erase the bio. The fallback check in Task 8 is what prevents this, and it must run before mounting.
- `StarterKit` v3 bundles Link and Underline. Options are `link`, `underline`, `heading`, `blockquote`, `code`, `codeBlock`, `strike`, `horizontalRule`, each accepting `false`.
- The minified bundle is about 144 KB gzipped.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/lib/rich-text.ts` | Create | Profiles, the 2,000 limit, `safeUrl`, `unsupportedToken`. No DOM, no Worker APIs, so both sides import it. |
| `src/lib/rich-text.test.ts` | Create | Unit tests for the above. |
| `src/lib/markdown.ts` | Modify | `renderMarkdown(source, { profile })`, `markdownToPlainText`. `safeUrl` moves out. |
| `src/lib/markdown.test.ts` | Modify | Tests for the `basic` profile and plain text. |
| `src/client/editor.ts` | Create | The browser editor: mount, toolbar, counter, submit guard. |
| `src/client/editor.test.ts` | Create | happy-dom tests for the editor. |
| `src/routes/shows.tsx`, `home.tsx`, `members.tsx` | Modify | Render synopsis and bio as markdown; plain text for teaser and meta. |
| `src/routes/admin.tsx` | Modify | Length limits, approvals rendering, `data-rich`, `richText` render prop. |
| `src/layouts/BaseLayout.tsx` | Modify | `richText` in the `ContextRenderer` props type. |
| `src/layouts/AdminLayout.tsx` | Modify | Emit the editor script when `richText` is set. |
| `src/routes/rich-text.workers-test.ts` | Create | Workers tests for public rendering, limits, approvals, and script loading. |
| `src/styles/global.css` | Modify | Typography plugin. |
| `package.json`, `.gitignore` | Modify | Dependencies and build scripts. |

---

### Task 1: Install the typography plugin

The `prose` classes on the news and About pages do nothing today. Fix that first, since every later task relies on them.

**Files:**
- Modify: `package.json`, `src/styles/global.css:1`

- [ ] **Step 1: Install**

```bash
npm i -D @tailwindcss/typography
```

- [ ] **Step 2: Register the plugin**

In `src/styles/global.css`, directly under line 1 (`@import 'tailwindcss';`), add:

```css
@plugin '@tailwindcss/typography';
```

- [ ] **Step 3: Verify the classes now exist**

```bash
npm run build:css && grep -o '\.prose-neutral' public/static/global.css | head -1 && grep -o '\.prose-invert' public/static/global.css | head -1
```

Expected: `.prose-neutral` printed. `.prose-invert` may not print yet, because no source uses it until Task 4. That is fine.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/styles/global.css
git commit -m "fix(styles): install the typography plugin the prose classes assume"
```

---

### Task 2: Shared rich text module

**Files:**
- Create: `src/lib/rich-text.ts`
- Create: `src/lib/rich-text.test.ts`
- Modify: `src/lib/markdown.ts:21-35` (remove `SAFE_SCHEMES` and `safeUrl`, import instead)

- [ ] **Step 1: Write the failing tests**

Create `src/lib/rich-text.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RICH_TEXT_PROFILE, safeUrl, unsupportedToken } from './rich-text';

const { Basic, Full } = RICH_TEXT_PROFILE;

describe('unsupportedToken', () => {
  it('accepts what a bio may contain', () => {
    const bio = 'Playing **Percy**, *finally*.\nSee [the show](https://x.example).\n\n- one\n- two\n\n1. a\n2. b';
    expect(unsupportedToken(bio, Basic)).toBeNull();
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

  it('refuses javascript and junk', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/rich-text.test.ts`
Expected: FAIL, cannot resolve `./rich-text`.

- [ ] **Step 3: Implement**

Create `src/lib/rich-text.ts`:

```ts
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
```

In `src/lib/markdown.ts`, delete `SAFE_SCHEMES` and the `safeUrl` function (lines 21-35) and add to the imports:

```ts
import { safeUrl } from '~/lib/rich-text';
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/rich-text.test.ts src/lib/markdown.test.ts`
Expected: PASS, including every existing markdown test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rich-text.ts src/lib/rich-text.test.ts src/lib/markdown.ts
git commit -m "feat(markdown): say in one place what each rich text field may contain"
```

---

### Task 3: `basic` rendering and plain text

**Files:**
- Modify: `src/lib/markdown.ts`
- Modify: `src/lib/markdown.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/markdown.test.ts`, and add `markdownToPlainText` to its import from `./markdown` and `RICH_TEXT_PROFILE` from `./rich-text`:

```ts
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
  ])('turns %j into %j', (source, plain) => {
    expect(markdownToPlainText(source)).toBe(plain);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/markdown.test.ts`
Expected: FAIL. `markdownToPlainText` is not exported, and the basic cases render headings.

- [ ] **Step 3: Implement**

Rewrite the body of `src/lib/markdown.ts` below the doc comment. Keep the file's opening comment. Add a paragraph to it saying bios use the `basic` profile, which renders everything outside `src/lib/rich-text.ts`'s basic set as the text the author typed.

```ts
import { Marked, type RendererObject, type Token, type Tokens } from 'marked';
import { escapeHtml } from '~/lib/html';
import { RICH_TEXT_PROFILE, type RichTextProfile, safeUrl } from '~/lib/rich-text';

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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/markdown.test.ts src/lib/rich-text.test.ts && npm run typecheck`
Expected: PASS. If `tsc` rejects `blockAsText` as a renderer method, type the parameter as the specific token (`Tokens.Heading`, and so on) through a small generic, not with `any`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/markdown.ts src/lib/markdown.test.ts
git commit -m "feat(markdown): render bios through a narrower profile, and extract plain text"
```

---

### Task 4: Render synopses and bios as markdown

**Files:**
- Modify: `src/routes/shows.tsx:146`, `:301`
- Modify: `src/routes/home.tsx:105-107`, `:458`
- Modify: `src/routes/members.tsx:2`, `:322`, `:347`
- Create: `src/routes/rich-text.workers-test.ts`

- [ ] **Step 1: Write the failing workers tests**

Create `src/routes/rich-text.workers-test.ts`:

```ts
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '~/db/queries';
import { members, MEMBER_VISIBILITY, showPerformances, shows } from '~/db/schema/content';
import { get, resetTables } from '~/test/session';

/**
 * Synopses and bios are stored as markdown written in the admin's rich text
 * editor. These check what reaches visitors: formatting where the page has
 * room for it, plain words where it does not.
 */

const db = () => getDb(env.DB);

const body = async (path: string) => {
  const res = await get(path);
  expect(res.status, `${path} did not render`).toBe(200);
  return res.text();
};

const metaDescription = (html: string) =>
  html.match(/<meta name="description" content="([^"]*)"/)?.[1];

beforeEach(async () => {
  await resetTables(['show_performances', 'shows', 'members']);
});

describe('a show synopsis', () => {
  beforeEach(async () => {
    await db().insert(shows).values({
      id: 'lightning-thief',
      title: 'The Lightning Thief',
      season: 'Spring 2099',
      year: 2099,
      synopsis: 'A **demigod** quest across America.\n\nSecond paragraph.',
      isAnnounced: true,
    });
    await db().insert(showPerformances).values({
      id: 'perf-1',
      showId: 'lightning-thief',
      date: '2099-05-01',
      time: '7:30 PM',
    });
  });

  it('is formatted on the show page', async () => {
    const html = await body('/shows/lightning-thief');
    expect(html).toContain('<strong>demigod</strong>');
    expect(html).toContain('<p>Second paragraph.</p>');
  });

  it('is plain words in the show page description', async () => {
    const html = await body('/shows/lightning-thief');
    expect(metaDescription(html)).toBe('A demigod quest across America. Second paragraph.');
  });

  it('is plain words in the home page hero and description', async () => {
    const html = await body('/');
    expect(html).toContain('A demigod quest across America. Second paragraph.');
    expect(html).not.toContain('**demigod**');
    expect(metaDescription(html)).not.toContain('**');
  });
});

describe('a member bio', () => {
  beforeEach(async () => {
    await db().insert(members).values({
      id: 'daniel-doser',
      name: 'Daniel Doser',
      grade: 'Senior',
      bio: 'Playing **Percy**.\n\n# Big news',
      visibility: MEMBER_VISIBILITY.Full,
      isActive: true,
    });
  });

  it('keeps emphasis but shows a heading as typed', async () => {
    const html = await body('/members/daniel-doser');
    expect(html).toContain('<strong>Percy</strong>');
    expect(html).toContain('# Big news');
    expect(html).not.toContain('<h1>Big news');
  });

  it('is plain words in the description', async () => {
    const html = await body('/members/daniel-doser');
    expect(metaDescription(html)).toBe('Playing Percy. Big news');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --config vitest.workers.config.ts src/routes/rich-text.workers-test.ts`
Expected: FAIL. The pages show `**demigod**` literally.

If the home test fails because the hero does not pick this show, read `getPromotedShows` (`src/db/queries.ts:124`) and its fallback `getLastClosedAnnouncedShow` (used at `src/routes/home.tsx:30`). The fixture needs to be an announced show with a future performance, and the test must match whatever the hero requires. Do not change the query.

- [ ] **Step 3: Implement**

`src/routes/shows.tsx`:
- Import `raw` from `hono/html`, and `markdownToPlainText` and `renderMarkdown` from `~/lib/markdown`.
- Replace line 146:

```tsx
<div class="prose prose-invert max-w-2xl mb-8 text-white/80">
  {raw(renderMarkdown(show.synopsis))}
</div>
```

- At line 301, set `description: markdownToPlainText(show.synopsis),`.

`src/routes/home.tsx`:
- Import `markdownToPlainText`.
- At line 106, render `{markdownToPlainText(featured.synopsis)}` inside the existing `<p>`.
- At line 458, use `${markdownToPlainText(featured.synopsis)}` in the template string.

`src/routes/members.tsx`:
- Change line 2 to `import { html, raw } from 'hono/html';`.
- Import `markdownToPlainText`, `renderMarkdown` and `RICH_TEXT_PROFILE`.
- Replace line 322:

```tsx
{member.bio && (
  <div class="prose prose-neutral max-w-none mt-6 text-neutral-700">
    {raw(renderMarkdown(member.bio, { profile: RICH_TEXT_PROFILE.Basic }))}
  </div>
)}
```

- At line 347, use `description: member.bio ? markdownToPlainText(member.bio) : \`${member.name} - Fairport Drama Club\``.

Put a comment above each `raw(...)` pointing at `src/lib/markdown.ts`, the way `misc.tsx:70-72` does.

- [ ] **Step 4: Run to verify pass, and nothing else broke**

Run: `npx vitest run --config vitest.workers.config.ts src/routes/rich-text.workers-test.ts src/routes/public-pages.workers-test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/shows.tsx src/routes/home.tsx src/routes/members.tsx src/routes/rich-text.workers-test.ts
git commit -m "feat(public): render synopses and bios as markdown, and keep syntax out of descriptions"
```

---

### Task 5: Enforce the length limit on the server

`maxlength` is the only limit today, and browsers ignore it once a script sets the value.

**Files:**
- Modify: `src/routes/admin.tsx`:
  - `/admin/profile` POST, after `const bio` at line 520
  - `/admin/members/:id` POST, where `const bio` (line 1935) moves above the photo upload (line 1925)
  - `/admin/shows/new` POST, line 3481
  - `/admin/shows/:id/details` POST, after `const { values } = await readShowForm(c);` (route at line 4048)
- Modify: `src/routes/rich-text.workers-test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/routes/rich-text.workers-test.ts` (`pending_edits` is already reset by `signIn`'s session tables, `src/test/session.ts:79`):
- Import `pendingEdits` and `APP_ROLE` from `~/db/schema/governance`, `RICH_TEXT_MAX_LENGTH` from `~/lib/rich-text`, and `post` and `signIn` from `~/test/session`.

Then append:

```ts
describe('the length limit', () => {
  const tooLong = 'x'.repeat(RICH_TEXT_MAX_LENGTH + 1);
  const justRight = 'x'.repeat(RICH_TEXT_MAX_LENGTH);

  beforeEach(async () => {
    await db().insert(members).values({
      id: 'daniel-doser',
      name: 'Daniel Doser',
      grade: 'Senior',
      bio: 'Original bio.',
      visibility: MEMBER_VISIBILITY.Limited,
    });
    await db().insert(shows).values({
      id: 'into-the-woods-2026',
      title: 'Into the Woods',
      season: 'Fall 2026',
      year: 2026,
      synopsis: 'Fairy tales collide.',
    });
  });

  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };

  it('refuses an over-long bio from the member', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    const res = await post('/admin/profile', cookie, form({ visibility: MEMBER_VISIBILITY.Limited, bio: tooLong, instagram: '' }));
    expect(res.headers.get('location')).toContain('error=');
    expect(await db().select().from(pendingEdits)).toHaveLength(0);
  });

  it('accepts a bio exactly at the limit', async () => {
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    const res = await post('/admin/profile', cookie, form({ visibility: MEMBER_VISIBILITY.Limited, bio: justRight, instagram: '' }));
    expect(res.headers.get('location')).not.toContain('error=');
  });

  it('refuses an over-long bio from an admin', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const res = await post('/admin/members/daniel-doser', cookie, form({
      name: 'Daniel Doser', grade: 'Senior', graduationYear: '2026', bio: tooLong,
      instagram: '', visibility: MEMBER_VISIBILITY.Limited, isActive: '1',
    }));
    expect(res.headers.get('location')).toContain('error=');
    const [row] = await db().select().from(members);
    expect(row!.bio).toBe('Original bio.');
  });

  it('refuses an over-long synopsis on a new show', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);
    const res = await post('/admin/shows/new', cookie, form({
      title: 'Wicked', season: 'Spring 2027', year: '2027', venue: '', synopsis: tooLong, ticketUrl: '',
    }));
    expect(res.headers.get('location')).toContain('error=');
    expect(await db().select().from(shows)).toHaveLength(1);
  });

  it('refuses an over-long synopsis on an existing show', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);
    const res = await post('/admin/shows/into-the-woods-2026/details', cookie, form({
      title: 'Into the Woods', season: 'Fall 2026', year: '2026', venue: '', synopsis: tooLong, ticketUrl: '',
    }));
    expect(res.headers.get('location')).toContain('error=');
    const [row] = await db().select().from(shows);
    expect(row!.synopsis).toBe('Fairy tales collide.');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --config vitest.workers.config.ts src/routes/rich-text.workers-test.ts -t "length limit"`
Expected: FAIL on the four refusals. The exactly-at-limit case passes.

- [ ] **Step 3: Implement**

In `src/routes/admin.tsx`, import `RICH_TEXT_MAX_LENGTH` from `~/lib/rich-text` and add one message constant near the top of the file:

```ts
const TOO_LONG = (what: string) =>
  `Keep the ${what} under ${RICH_TEXT_MAX_LENGTH.toLocaleString('en-US')} characters.`;
```

Then add one guard to each handler, after the value is read and before anything is written:

```ts
// /admin/profile, after `const bio = ...`
if (bio.length > RICH_TEXT_MAX_LENGTH) {
  return c.redirect(`/admin/profile?error=${encodeURIComponent(TOO_LONG('bio'))}`, 302);
}

// /admin/members/:id: move `const bio = ...` up to just before the
// `let photoImageId` upload block, and guard it there
if (bio.length > RICH_TEXT_MAX_LENGTH) return back(`?error=${encodeURIComponent(TOO_LONG('bio'))}`);

// /admin/shows/new, after `const { values } = await readShowForm(c);`
if (values.synopsis.length > RICH_TEXT_MAX_LENGTH) {
  return c.redirect(`/admin/shows/new?error=${encodeURIComponent(TOO_LONG('synopsis'))}`, 302);
}

// /admin/shows/:id/details, after `const { values } = await readShowForm(c);`
if (values.synopsis.length > RICH_TEXT_MAX_LENGTH) {
  return c.redirect(`/admin/shows/${showId}?error=${encodeURIComponent(TOO_LONG('synopsis'))}`, 302);
}
```

Both bio guards must come before their handler's photo upload, so a rejected bio does not leave an orphaned image. In `/admin/profile` `const bio` is already above the upload; in `/admin/members/:id` it is below it (`admin.tsx:1925-1935`) and has to move.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --config vitest.workers.config.ts src/routes/rich-text.workers-test.ts src/routes/admin-shows.workers-test.ts src/routes/admin-member-edit.workers-test.ts src/routes/admin-upload.workers-test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.tsx src/routes/rich-text.workers-test.ts
git commit -m "fix(admin): enforce the bio and synopsis limit on the server, not only in the browser"
```

---

### Task 6: Show approvers the bio as it will publish

**Files:**
- Modify: `src/routes/admin.tsx:563-584` (`ProposedValue`)
- Modify: `src/routes/rich-text.workers-test.ts`

- [ ] **Step 1: Write the failing test**

In `src/routes/rich-text.workers-test.ts`, import `AUDIT_ENTITY_KIND` from `~/lib/audit/constants`, and `PENDING_EDIT_STATUS` from `~/db/schema/governance`, alongside the existing names. Then append:

```ts
describe('the approvals queue', () => {
  it('renders a proposed bio, and keeps its source one click away', async () => {
    await db().insert(members).values({
      id: 'daniel-doser',
      name: 'Daniel Doser',
      grade: 'Senior',
      bio: 'Old bio.',
      visibility: MEMBER_VISIBILITY.Full,
    });
    await db().insert(pendingEdits).values({
      id: 'pe-1',
      targetKind: AUDIT_ENTITY_KIND.Member,
      targetId: 'daniel-doser',
      proposed: { bio: 'A **new** bio with [a link](https://evil.example).' },
      submittedByUserId: 'u_someone',
      submittedAt: '2026-09-18T00:00:00.000Z',
      status: PENDING_EDIT_STATUS.Pending,
    });

    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const res = await get('/admin/approvals', cookie);
    const html = await res.text();

    expect(html).toContain('<strong>new</strong>');
    expect(html).toContain('Show source');
    // The link's destination must be visible without hovering it.
    expect(html).toContain('[a link](https://evil.example)');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --config vitest.workers.config.ts src/routes/rich-text.workers-test.ts -t "approvals"`
Expected: FAIL, because `**new**` is shown literally.

- [ ] **Step 3: Implement**

In `src/routes/admin.tsx`, import `raw` from `hono/html`, `renderMarkdown` from `~/lib/markdown`, and `RICH_TEXT_PROFILE` from `~/lib/rich-text`, the latter merged into the Task 5 import. In `ProposedValue`, before the final `return`, add:

```tsx
// A rendered link hides where it goes, and the approver is accepting
// responsibility for it, so the source stays one click away.
if (field === 'bio' && typeof value === 'string' && value.length > 0) {
  return (
    <div>
      <div class="prose prose-neutral prose-sm max-w-none">
        {raw(renderMarkdown(value, { profile: RICH_TEXT_PROFILE.Basic }))}
      </div>
      <details class="mt-2">
        <summary class="cursor-pointer text-xs text-neutral-500">Show source</summary>
        <pre class="mt-1 text-xs whitespace-pre-wrap text-neutral-700">{value}</pre>
      </details>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --config vitest.workers.config.ts src/routes/rich-text.workers-test.ts src/routes/admin-pages.workers-test.ts`
Expected: PASS. The existing `approvals renders the proposed photo` test still finds `A new bio.`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.tsx src/routes/rich-text.workers-test.ts
git commit -m "feat(approvals): show a proposed bio as it will publish, with its source to hand"
```

---

### Task 7: Editor build tooling

**Files:**
- Modify: `package.json`, `.gitignore`
- Create: `src/client/editor.ts` (a placeholder this task, filled in by Task 8)

- [ ] **Step 1: Install**

```bash
npm i @tiptap/core@^3.31 @tiptap/pm@^3.31 @tiptap/starter-kit@^3.31 @tiptap/markdown@^3.31 @tiptap/extension-image@^3.31
npm i -D esbuild@^0.28
```

The Tiptap packages go in `dependencies` because they ship to users in the bundle; esbuild is a build tool and goes in `devDependencies`, like `tailwindcss`.

If npm warns about install scripts, add the exact `esbuild@<version>` it names to the `allowScripts` map in `package.json`, matching the existing entries.

- [ ] **Step 2: Add scripts**

In `package.json` `scripts`:

```json
"build:editor": "esbuild src/client/editor.ts --bundle --minify --format=esm --target=es2022 --outfile=public/static/editor.js",
"build:editor:watch": "npm run build:editor -- --watch",
```

Change `dev` and `deploy` so each runs `npm run build:editor` after `npm run build:css`:

```json
"dev": "npm run build:css && npm run build:editor && wrangler dev",
"deploy": "npm run build:css && npm run build:editor && wrangler deploy --env production",
```

- [ ] **Step 3: Ignore the output**

In `.gitignore`, under `public/static/global.css`, add:

```
public/static/editor.js
```

- [ ] **Step 4: Placeholder entry and build check**

Create `src/client/editor.ts`:

```ts
/// <reference lib="dom" />
export {};
```

Run: `npm run build:editor && ls -la public/static/editor.js && npm run typecheck`
Expected: the file exists and typecheck passes. esbuild resolves `~/` imports from `tsconfig.json`'s `paths` on its own.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore src/client/editor.ts
git commit -m "build: bundle a browser script for the admin editor"
```

---

### Task 8: Mount the editor, or fall back

**Files:**
- Modify: `src/client/editor.ts`
- Create: `src/client/editor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/client/editor.test.ts`:

```ts
/// <reference lib="dom" />
/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { renderMarkdown } from '~/lib/markdown';
import { mountRichText } from './editor';

const setup = (attrs: string, value: string) => {
  document.body.innerHTML = `<form><textarea ${attrs}></textarea></form>`;
  const textarea = document.querySelector('textarea')!;
  textarea.value = value;
  return textarea;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('mounting', () => {
  it('hides the textarea, drops required, and loads its markdown', () => {
    const textarea = setup('data-rich="basic" required', 'Line one\nLine two');
    const mounted = mountRichText(textarea)!;

    expect(textarea.hidden).toBe(true);
    expect(textarea.required).toBe(false);
    expect(mounted.editor.getMarkdown()).toBe('Line one\nLine two');
  });

  it('leaves the text untouched until someone edits it', () => {
    const textarea = setup('data-rich="full"', 'Price is 5 * 3');
    mountRichText(textarea);
    expect(textarea.value).toBe('Price is 5 * 3');
  });

  it('writes markdown back on every edit', () => {
    const textarea = setup('data-rich="full"', 'Hello');
    const { editor } = mountRichText(textarea)!;

    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.toggleBold();
    expect(textarea.value).toBe('**Hello**');
  });

  it('round-trips plain text through an edit and an undo', () => {
    const source = 'Line one\nLine two\n\nNew paragraph.';
    const textarea = setup('data-rich="basic"', source);
    const { editor } = mountRichText(textarea)!;

    editor.commands.focus('end');
    editor.commands.insertContent('!');
    editor.commands.undo();
    expect(textarea.value).toBe(source);
  });

  it('renders literal markdown characters the same after an edit', () => {
    // They come back escaped (`5 \\* 3`), which marked renders identically.
    const source = 'Tickets are 5 * 3 dollars, my_var stays, and #1 is fine.';
    const textarea = setup('data-rich="basic"', source);
    const { editor } = mountRichText(textarea)!;

    editor.commands.focus('end');
    editor.commands.insertContent('!');
    editor.commands.undo();
    expect(renderMarkdown(textarea.value)).toBe(renderMarkdown(source));
  });

  it('round-trips a synopsis shaped like the real ones', () => {
    // The seed data is generated and gitignored, so this stands in for it.
    const source =
      'A demigod quest across America.\n\nPercy must find the lightning bolt\nbefore the summer solstice.';
    const textarea = setup('data-rich="full"', source);
    const { editor } = mountRichText(textarea)!;

    editor.commands.focus('end');
    editor.commands.insertContent('!');
    editor.commands.undo();
    expect(textarea.value).toBe(source);
  });

  it('drops a heading pasted into a bio but keeps its words', () => {
    const textarea = setup('data-rich="basic"', 'Bio');
    const { editor } = mountRichText(textarea)!;

    editor.commands.focus('end');
    editor.commands.insertContent('<h1>Pasted</h1>');
    expect(textarea.value).toContain('Pasted');
    expect(textarea.value).not.toContain('#');
  });
});

describe('falling back to the plain textarea', () => {
  // Tiptap loads a document with an unregistered node as empty, so mounting
  // here would erase the field on the next save.
  it.each([
    ['basic', '# Big news'],
    ['basic', '> quoted'],
    ['full', '| a |\n|---|\n| 1 |'],
    ['full', '<b>raw</b>'],
  ])('leaves a %s field holding %j alone and says why', (profile, source) => {
    const textarea = setup(`data-rich="${profile}" required`, source);

    expect(mountRichText(textarea)).toBeNull();
    expect(textarea.hidden).toBe(false);
    expect(textarea.required).toBe(true);
    expect(textarea.value).toBe(source);
    expect(document.body.textContent).toContain("formatting the editor can't show");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/client/editor.test.ts`
Expected: FAIL, because `mountRichText` is not exported.

- [ ] **Step 3: Implement**

Replace `src/client/editor.ts`:

```ts
/// <reference lib="dom" />
import { Editor, type Extensions } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import {
  RICH_TEXT_PROFILE,
  type RichTextProfile,
  safeUrl,
  unsupportedToken,
} from '~/lib/rich-text';

/**
 * The admin's rich text editor.
 *
 * It enhances a `<textarea data-rich="full|basic">` rather than replacing the
 * form: the textarea stays in the form, hidden, and holds the markdown the
 * server receives. Without this script the textarea is simply visible.
 */

export interface MountedEditor {
  editor: Editor;
  textarea: HTMLTextAreaElement;
}

const profileOf = (textarea: HTMLTextAreaElement): RichTextProfile =>
  textarea.dataset.rich === RICH_TEXT_PROFILE.Basic
    ? RICH_TEXT_PROFILE.Basic
    : RICH_TEXT_PROFILE.Full;

function extensionsFor(profile: RichTextProfile): Extensions {
  // Nodes a profile leaves out are not registered at all, so pasted content
  // using them is reduced to its text rather than smuggled in.
  const off = profile === RICH_TEXT_PROFILE.Basic ? false : undefined;
  const kit = StarterKit.configure({
    // Markdown has no underline, so it could not be saved.
    underline: false,
    heading: off,
    blockquote: off,
    code: off,
    codeBlock: off,
    strike: off,
    horizontalRule: off,
    link: {
      openOnClick: false,
      autolink: false,
      isAllowedUri: (url) => safeUrl(url) !== null,
    },
  });
  return profile === RICH_TEXT_PROFILE.Basic ? [kit, Markdown] : [kit, Image, Markdown];
}

export function mountRichText(textarea: HTMLTextAreaElement): MountedEditor | null {
  const profile = profileOf(textarea);

  if (unsupportedToken(textarea.value, profile) !== null) {
    const note = document.createElement('p');
    note.className = 'text-xs text-neutral-500 mt-1';
    note.textContent = "This text has formatting the editor can't show, so it opens as plain text.";
    textarea.after(note);
    return null;
  }

  const frame = document.createElement('div');
  frame.className =
    'rounded-lg border border-neutral-300 bg-white focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500';
  const host = document.createElement('div');
  frame.append(host);
  textarea.after(frame);

  // A hidden required control blocks submit with a message nobody can see.
  // The submit guard added in Task 10 takes over the check.
  textarea.hidden = true;
  textarea.required = false;

  const editor = new Editor({
    element: host,
    extensions: extensionsFor(profile),
    content: textarea.value,
    contentType: 'markdown',
    editorProps: {
      attributes: {
        class: 'prose prose-neutral max-w-none min-h-40 px-4 py-3 focus:outline-none',
      },
    },
    onUpdate: ({ editor }) => {
      textarea.value = editor.getMarkdown();
    },
  });

  return { editor, textarea };
}

// A module script runs after the document is parsed, so every field exists.
// Under test the document is empty at import time and this finds nothing.
for (const textarea of document.querySelectorAll<HTMLTextAreaElement>('textarea[data-rich]')) {
  mountRichText(textarea);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/client/editor.test.ts && npm run typecheck && npm run build:editor`
Expected: PASS, and the bundle builds.

- [ ] **Step 5: Commit**

```bash
git add src/client/editor.ts src/client/editor.test.ts
git commit -m "feat(admin): mount a markdown editor over rich text fields, or leave them be"
```

---

### Task 9: Toolbar

**Files:**
- Modify: `src/client/editor.ts`
- Modify: `src/client/editor.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/client/editor.test.ts`:

```ts
const buttons = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-rich-toolbar] button')].map(
    (b) => b.textContent,
  );
const click = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-rich-toolbar] button')]
    .find((b) => b.textContent === label)!
    .click();

describe('the toolbar', () => {
  it('offers headings and quotes for full fields', () => {
    mountRichText(setup('data-rich="full"', 'x'));
    expect(buttons()).toEqual([
      'Bold', 'Italic', 'Heading', 'Subheading', 'Bullets', 'Numbers', 'Quote', 'Link', 'Undo', 'Redo',
    ]);
  });

  it('offers only what a bio may hold', () => {
    mountRichText(setup('data-rich="basic"', 'x'));
    expect(buttons()).toEqual(['Bold', 'Italic', 'Bullets', 'Numbers', 'Link', 'Undo', 'Redo']);
  });

  it('never submits the form', () => {
    mountRichText(setup('data-rich="full"', 'x'));
    for (const b of document.querySelectorAll('[data-rich-toolbar] button')) {
      expect(b.getAttribute('type')).toBe('button');
    }
  });

  it('applies formatting and reports it with aria-pressed', () => {
    const textarea = setup('data-rich="full"', 'Hello');
    const { editor } = mountRichText(textarea)!;
    editor.commands.setTextSelection({ from: 1, to: 6 });

    click('Bold');
    expect(textarea.value).toBe('**Hello**');
    const bold = [...document.querySelectorAll('[data-rich-toolbar] button')].find(
      (b) => b.textContent === 'Bold',
    )!;
    expect(bold.getAttribute('aria-pressed')).toBe('true');
  });

  it('links to a safe address', () => {
    const textarea = setup('data-rich="full"', 'Hello');
    const { editor } = mountRichText(textarea)!;
    editor.commands.setTextSelection({ from: 1, to: 6 });
    window.prompt = () => 'https://example.com';

    click('Link');
    expect(textarea.value).toBe('[Hello](https://example.com)');
  });

  it('refuses an unsafe address and says so', () => {
    const textarea = setup('data-rich="full"', 'Hello');
    const { editor } = mountRichText(textarea)!;
    editor.commands.setTextSelection({ from: 1, to: 6 });
    window.prompt = () => 'javascript:alert(1)';

    click('Link');
    expect(textarea.value).toBe('Hello');
    expect(document.body.textContent).toContain('Links must start with');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/client/editor.test.ts`
Expected: FAIL, because there is no toolbar.

- [ ] **Step 3: Implement**

In `src/client/editor.ts`, add above `mountRichText`:

```ts
interface Tool {
  label: string;
  /** `status` is the line under the editor, for anything the tool must say. */
  run: (editor: Editor, status: HTMLElement) => void;
  active?: (editor: Editor) => boolean;
  profiles: readonly RichTextProfile[];
}

const BOTH = [RICH_TEXT_PROFILE.Full, RICH_TEXT_PROFILE.Basic] as const;
const FULL_ONLY = [RICH_TEXT_PROFILE.Full] as const;

const LINK_RULE = 'Links must start with https://, http://, mailto:, or /.';

function promptForLink(editor: Editor, status: HTMLElement) {
  const previous = editor.getAttributes('link').href as string | undefined;
  const entered = window.prompt('Link address (leave empty to remove the link)', previous ?? 'https://');
  if (entered === null) return;
  if (entered.trim() === '') {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }
  const href = safeUrl(entered);
  if (href === null) {
    status.textContent = LINK_RULE;
    return;
  }
  editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
}

const TOOLS: Tool[] = [
  { label: 'Bold', profiles: BOTH, run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive('bold') },
  { label: 'Italic', profiles: BOTH, run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive('italic') },
  { label: 'Heading', profiles: FULL_ONLY, run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), active: (e) => e.isActive('heading', { level: 2 }) },
  { label: 'Subheading', profiles: FULL_ONLY, run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), active: (e) => e.isActive('heading', { level: 3 }) },
  { label: 'Bullets', profiles: BOTH, run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive('bulletList') },
  { label: 'Numbers', profiles: BOTH, run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive('orderedList') },
  { label: 'Quote', profiles: FULL_ONLY, run: (e) => e.chain().focus().toggleBlockquote().run(), active: (e) => e.isActive('blockquote') },
  { label: 'Link', profiles: BOTH, run: promptForLink, active: (e) => e.isActive('link') },
  { label: 'Undo', profiles: BOTH, run: (e) => e.chain().focus().undo().run() },
  { label: 'Redo', profiles: BOTH, run: (e) => e.chain().focus().redo().run() },
];
```

In `mountRichText`, create the toolbar and a status line:

```ts
const toolbar = document.createElement('div');
toolbar.dataset.richToolbar = '';
toolbar.className = 'flex flex-wrap gap-1 border-b border-neutral-200 p-1';
frame.prepend(toolbar);

const status = document.createElement('p');
status.className = 'text-xs text-neutral-500 mt-1';
status.setAttribute('aria-live', 'polite');
frame.after(status);

const tools = TOOLS.filter((t) => t.profiles.includes(profile)).map((tool) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = tool.label;
  button.className =
    'px-2 py-1 text-sm rounded text-neutral-700 hover:bg-neutral-100 aria-pressed:bg-neutral-200 aria-pressed:text-neutral-900';
  toolbar.append(button);
  return { tool, button };
});
```

After `new Editor(...)`, wire the buttons and keep `aria-pressed` current:

```ts
for (const { tool, button } of tools) {
  button.addEventListener('click', () => tool.run(editor, status));
}
const refresh = () => {
  for (const { tool, button } of tools) {
    if (tool.active) button.setAttribute('aria-pressed', String(tool.active(editor)));
  }
};
editor.on('transaction', refresh);
refresh();
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/client/editor.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/editor.ts src/client/editor.test.ts
git commit -m "feat(admin): give the editor a toolbar that matches what the field allows"
```

---

### Task 10: Counter and submit guard

**Files:**
- Modify: `src/client/editor.ts`
- Modify: `src/client/editor.test.ts`

The limit is read from the textarea's own `maxlength` attribute, which the bio and synopsis already carry, so nothing else has to say which fields are limited.

- [ ] **Step 1: Write the failing tests**

Append:

```ts
const submit = (form: HTMLFormElement) => {
  const event = new Event('submit', { cancelable: true });
  form.dispatchEvent(event);
  return event.defaultPrevented;
};

describe('the counter', () => {
  it('counts markdown, not visible text', () => {
    const textarea = setup('data-rich="basic" maxlength="2000"', '[a](https://example.com)');
    mountRichText(textarea);
    expect(document.body.textContent).toContain('24 / 2,000');
  });

  it('is absent on fields without a limit', () => {
    mountRichText(setup('data-rich="full"', 'x'));
    expect(document.body.textContent).not.toContain('/ ');
  });
});

describe('submitting', () => {
  it('stops an empty required field and says so', () => {
    const textarea = setup('data-rich="full" required', '');
    mountRichText(textarea);
    expect(submit(textarea.form!)).toBe(true);
    expect(document.body.textContent).toContain("This can't be empty.");
  });

  it('stops a field over its limit', () => {
    const textarea = setup('data-rich="basic" maxlength="5"', 'abcdef');
    mountRichText(textarea);
    expect(submit(textarea.form!)).toBe(true);
    expect(document.body.textContent).toContain('1 character over the limit');
  });

  it('clears the empty-field message once someone types', () => {
    const textarea = setup('data-rich="full" required', '');
    const { editor } = mountRichText(textarea)!;
    submit(textarea.form!);

    editor.commands.insertContent('Now it has words.');
    expect(document.body.textContent).not.toContain("This can't be empty.");
  });

  it('lets a valid field through', () => {
    const textarea = setup('data-rich="full" required maxlength="2000"', 'Fine.');
    mountRichText(textarea);
    expect(submit(textarea.form!)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/client/editor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `mountRichText`, before hiding the textarea, capture what it enforced:

```ts
const required = textarea.required;
const limit = textarea.maxLength > 0 ? textarea.maxLength : null;
```

After the toolbar wiring:

```ts
const count = () => {
  if (limit === null) {
    // Nothing to count, but a message from a stopped submit is now stale.
    status.textContent = '';
    status.classList.remove('text-red-600');
    return;
  }
  const length = textarea.value.length;
  status.textContent = `${length.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')}`;
  status.classList.toggle('text-red-600', length > limit);
};
editor.on('update', count);
count();

textarea.form?.addEventListener('submit', (event) => {
  const value = textarea.value;
  let problem: string | null = null;
  if (required && value.trim() === '') problem = "This can't be empty.";
  else if (limit !== null && value.length > limit) {
    const over = value.length - limit;
    problem = `This is ${over.toLocaleString('en-US')} character${over === 1 ? '' : 's'} over the limit.`;
  }
  if (problem === null) return;
  event.preventDefault();
  status.textContent = problem;
  status.classList.add('text-red-600');
  editor.commands.focus();
});
```

The `update` listener that writes `textarea.value` is registered in the `Editor` constructor, before `count` is registered, so `count` always reads the fresh value.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/client/editor.test.ts && npm run typecheck && npm run build:editor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/editor.ts src/client/editor.test.ts
git commit -m "feat(admin): count the editor's markdown and stop a submit the server would refuse"
```

---

### Task 11: Wire the editor into the admin forms

**Files:**
- Modify: `src/layouts/BaseLayout.tsx:14-26`
- Modify: `src/layouts/AdminLayout.tsx:52`, `:66`
- Modify: `src/routes/admin.tsx`:
  - Textareas at lines 419, 1654, 2995 and 3384.
  - The `c.render` props of the six GET routes: `/admin/profile` (309), `/admin/members/:id` (1510), `/admin/news/new` (3061), `/admin/news/:id` (3096), `/admin/shows/new` (3435) and `/admin/shows/:id` (3508).
- Modify: `src/routes/rich-text.workers-test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/routes/rich-text.workers-test.ts`:

```ts
describe('loading the editor', () => {
  it('happens on pages with a rich field, and marks the field', async () => {
    const cookie = await signIn('director@example.com', APP_ROLE.Staff);
    const html = await (await get('/admin/shows/new', cookie)).text();

    expect(html).toContain('src="/static/editor.js"');
    expect(html).toMatch(/<textarea[^>]*name="synopsis"[^>]*data-rich="full"/);
  });

  it('marks bios as basic', async () => {
    await db().insert(members).values({
      id: 'daniel-doser', name: 'Daniel Doser', grade: 'Senior', visibility: MEMBER_VISIBILITY.Limited,
    });
    const cookie = await signIn('student@example.com', APP_ROLE.Member, 'daniel-doser');
    const html = await (await get('/admin/profile', cookie)).text();

    expect(html).toMatch(/<textarea[^>]*name="bio"[^>]*data-rich="basic"/);
  });

  it('does not happen elsewhere in the admin', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    const html = await (await get('/admin/accounts', cookie)).text();
    expect(html).not.toContain('editor.js');
  });

  it('never happens on the public site', async () => {
    expect(await body('/')).not.toContain('editor.js');
  });
});
```

Hono JSX writes attributes in source order, so in Step 3 put `data-rich` directly after `name` on all four textareas.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --config vitest.workers.config.ts src/routes/rich-text.workers-test.ts -t "loading the editor"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/layouts/BaseLayout.tsx`: in the `ContextRenderer` props type, add:

```ts
/** Admin only: load the rich text editor bundle. */
richText?: boolean;
```

`src/layouts/AdminLayout.tsx`: next to `title` at line 52, read `const richText = (props as { richText?: boolean }).richText ?? false;`. If the augmented type now makes the cast unnecessary, drop both casts. Under the stylesheet link at line 66:

```tsx
{richText && <script type="module" src="/static/editor.js"></script>}
```

`src/routes/admin.tsx`:
- Add `data-rich="basic"` to the bio textareas at lines 419 and 1654, directly after `name`.
- Add `data-rich="full"` to the post body (2995) and synopsis (3384), directly after `name`.
- Keep `maxlength` and `required` as they are. The editor reads them.
- Add `richText: true` to the render props of the six routes above, for example `{ title: 'My Profile', richText: true }`. Only the render that shows the form: `/admin/profile` GET has an earlier `c.render` at line 323 for an account with no linked member, which has no bio field and stays as it is.
- Remove `font-mono` from the post body textarea's classes. It is now only seen when the editor falls back, and then it is prose.

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:integration && npm run typecheck`
Expected: PASS across the whole workers suite.

- [ ] **Step 5: Commit**

```bash
git add src/layouts/BaseLayout.tsx src/layouts/AdminLayout.tsx src/routes/admin.tsx src/routes/rich-text.workers-test.ts
git commit -m "feat(admin): edit news, synopses, and bios in the rich text editor"
```

---

### Task 12: Verify in a browser

Use @superpowers:verification-before-completion. Tests cannot show you that the editor looks right.

- [ ] **Step 1: Full suite**

Run: `npm test && npm run typecheck`
Expected: every test passes, with the counts reported.

- [ ] **Step 2: Run the app**

Run: `npm run dev`, and sign in to `/admin` locally. `npm run bootstrap:admin` creates an account if you need one.

- [ ] **Step 3: Walk the three fields**

For each field, check the result and report it:

- **News** (`/admin/news/new`):
  - Write a post with a heading, a list, a quote, a link and bold text, then save.
  - Open `/news/<id>`: the formatting shows and is styled.
  - Reopen the post: it loads in the editor unchanged.
- **Show** (`/admin/shows/:id`):
  - Give the synopsis two paragraphs and a bold phrase, then save.
  - The show page renders it on the dark hero.
  - The home hero shows the plain words.
  - Type past 2,000 characters: the counter turns red and submit is stopped.
- **Bio** (`/admin/profile`):
  - The toolbar has no Heading or Quote.
  - Paste a heading from another page: it arrives as plain text.
  - Submit, then approve it in `/admin/approvals`. The rendered bio and "Show source" both appear.
- **Fallback:** put `| a |\n|---|\n| 1 |` into a news post's `body_md` directly with `wrangler d1 execute --local`, then open it. It shows as a plain textarea with the note.
- **No script:** disable JavaScript in the browser. Each form still submits from its textarea.

- [ ] **Step 4: Check the bundle size**

Run: `gzip -c public/static/editor.js | wc -c`
Expected: roughly 150,000 or under. Report the number.

- [ ] **Step 5: Hand back**

Report what was checked and anything that looked wrong. Do not open a PR; the user decides that. Note in the report that `.prose-article` in `src/styles/global.css:265` is unused.
