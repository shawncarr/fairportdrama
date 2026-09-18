# Rich text editing in the admin

**Date:** 2026-09-18
**Status:** Approved, ready for planning

## Problem

The admin edits long-form content in bare `<textarea>`s, and the public site mostly throws the formatting away.

| Field | Edited at | Rendered at | How |
|---|---|---|---|
| News post body | `src/routes/admin.tsx:2995` | `src/routes/misc.tsx:73` | `renderMarkdown` inside `.prose` |
| Show synopsis | `src/routes/admin.tsx:3384` | `src/routes/shows.tsx:146`, `src/routes/home.tsx:106` | `{text}` in a `<p>` |
| Member bio (self) | `src/routes/admin.tsx:419` (`/admin/profile`) | `src/routes/members.tsx:322` | `{text}` in a `<p>` |
| Member bio (admin) | `src/routes/admin.tsx:1654` (`/admin/members/:id`) | same | same |

Three faults follow from this:

- Synopses and bios render inside a `<p>`, so line breaks collapse and a multi-paragraph synopsis becomes one block.
- News is markdown, but the `prose prose-neutral` classes on `misc.tsx:72` and `about.tsx:81` come from `@tailwindcss/typography`, which is not installed. Tailwind's preflight resets headings, lists, and blockquotes, so the formatting the author wrote is invisible.
- Only a developer can write markdown with confidence. The people running the admin are not developers.

## Goals

Give admins and students a visual editor for the three long-form fields, keep markdown as the stored format, and make the public site render what the editor showed.

## Non-goals

- The news summary (`admin.tsx:2976`) and spirit wear description (`admin-catalog.tsx:449`). They are short and stay plain textareas.
- The bulk invite textarea (`admin.tsx:2572`). It is data entry, not content.
- Images inside the editor. News already has its own image field.
- A schema change. The columns stay `text`, and existing plain-text values are valid markdown under `breaks: true`. The seed data has no synopsis or bio line starting with `-`, `1.`, `#`, or `>`, so nothing turns into an unintended list or heading.
- An in-editor raw markdown toggle. The no-JS textarea already covers raw editing.
- Storing HTML. It would need sanitizing in workerd, the problem `src/lib/markdown.ts` exists to avoid.

## Design

### 1. Editor bundle

Tiptap v3 with the first-party markdown extension. New dependencies: `@tiptap/core`, `@tiptap/starter-kit`, `@tiptap/markdown`, and `@tiptap/extension-image`. StarterKit v3 already bundles Link, so there is no separate link package. `esbuild` is added as a dev dependency with an entry in `package.json`'s `allowScripts` map, rather than relying on wrangler's copy.

Source lives in `src/client/editor.ts`. `build:editor` bundles it to `public/static/editor.js` as a minified ES module, and `build:editor:watch` mirrors `build:css:watch`. `dev` and `deploy` run `build:editor` alongside `build:css`, and `public/static/editor.js` joins `public/static/global.css` in `.gitignore`.

`src/client/` has its own `tsconfig.json` that extends the root one, swaps the Workers types for the `DOM` lib, and is excluded from the root project. A `/// <reference lib="dom" />` is not enough: the Workers types declare HTMLRewriter's `Element`, which merges with the DOM's and breaks calls like `el.after()`. `typecheck` runs `tsc` over both projects. The editor tests opt into happy-dom with the `@vitest-environment happy-dom` docblock.

### 2. Loading

`adminLayout` (`src/layouts/AdminLayout.tsx:49`) reads an optional `richText` prop. It is added to the `ContextRenderer` augmentation in `src/layouts/BaseLayout.tsx:14`, alongside `title`. When set, the layout emits `<script type="module" src="/static/editor.js">`. Six GET routes pass it: `/admin/profile`, `/admin/members/:id`, `/admin/news/new`, `/admin/news/:id`, `/admin/shows/new`, and `/admin/shows/:id`. Their POST handlers redirect on error rather than re-rendering, so no other path needs it. No public page loads the bundle.

### 3. Progressive enhancement

The editor enhances a textarea; it never replaces the form.

1. On load, the script finds every `textarea[data-rich]`.
2. It runs the source through `marked.lexer`. If any token is a type the field's profile does not register (for `full`: a table or raw HTML; for `basic`: anything outside paragraphs, emphasis, links and lists), it leaves the textarea alone and adds a one-line note under it: "This text has formatting the editor can't show, so it opens as plain text." Nothing is lost by opening it.
3. Otherwise it hides the textarea, removes its `required` attribute (a hidden required control blocks submit with no visible message), mounts Tiptap in a sibling element, and loads the value with `contentType: 'markdown'`.
4. On every `update` it writes `editor.getMarkdown()` back into the textarea.
5. On submit, a field that was `required` and is empty, or is over its length limit (section 4), stops the submit, shows an inline message under the editor, and focuses it.

If the script fails to load, the textarea is there, still `required`, and still works. That is also the escape hatch for anyone who wants to write raw markdown: there is no in-editor source toggle.

### 4. Profiles

The attribute value picks a profile. The profile sets the toolbar and which StarterKit parts are enabled, so pasting a node the profile does not register keeps the text and drops the formatting. Underline is always disabled because markdown cannot store it.

| Profile | Fields | Toolbar | Also enabled so existing content survives |
|---|---|---|---|
| `full` | News body, synopsis | Bold, italic, H2, H3, bullet list, numbered list, blockquote, link, undo, redo | Image, inline code, code block, strike, horizontal rule |
| `basic` | Bio (both forms) | Bold, italic, link, bullet list, numbered list, undo, redo | none |

In either profile, every token in the source is either modelled by the editor or triggers the plain-text fallback in step 2, so opening and saving never silently drops content. A bio written without the editor that contains `# Hi` opens as plain text rather than losing the `#`.

Links are validated in the link dialog with the same scheme rule as the server (`http:`, `https:`, `mailto:`, relative).

Under the bio and synopsis editors, a counter shows `getMarkdown().length` against 2,000 ("1,240 / 2,000"), recomputed on each update. It counts the markdown source, the same thing the server limits (section 5), so link URLs and syntax count. Past the limit it turns red and blocks submit through the inline message path in step 3.5. The server rejects over-limit input by redirecting, which loses what was typed, so the client has to stop it first, as `maxlength` did before.

The toolbar is plain `<button type="button">`s with text labels and `aria-pressed` reflecting the active mark. The editable area carries `prose prose-neutral`, so it previews the public styling.

### 5. Server-side limits

The server does not check length today. Bio and synopsis rely on `maxlength={2000}` alone (`admin.tsx:423`, `:1654`, `:3389`). Browsers do not apply `maxlength` to a value set by script, so with the editor on, nothing caps them. The bio handlers (`admin.tsx:520`, `:1935`) and the show create and update handlers reject a bio or synopsis over 2,000 characters of markdown source. They use each handler's existing error redirect and message. The news body keeps no limit, as today.

### 6. Server rendering

`renderMarkdown(source, { profile })` gains a profile option. It defaults to `full`, so the news call site does not change. `basic` is a second `Marked` instance, because the current one is module-level (`markdown.ts:37`). It shares the `link` and `html` renderers, and returns `<p>` + `escapeHtml(token.raw)` + `</p>` for everything else it does not allow:

- block level: heading (ATX and setext), blockquote, code block, table, hr
- inline: image, codespan, del
- a GFM task list checkbox, shown as `[ ]` or `[x]` rather than an input

This is the enforcement for bios, because a student can post the form without the editor.

New `markdownToPlainText(source)` walks `marked.lexer` tokens and joins their text, for places that need a string.

| Site | Change |
|---|---|
| `shows.tsx:146` | Rendered `full` markdown in `prose prose-invert` (the hero is dark). |
| `home.tsx:106` | Plain text via `markdownToPlainText`. The hero is a teaser; headings and lists do not belong in it. |
| `members.tsx:322` | Rendered `basic` markdown in `prose prose-neutral`. |
| `home.tsx:458`, `shows.tsx:301`, `members.tsx:347` | Meta descriptions use `markdownToPlainText`. |
| `/admin/approvals` (`ProposedValue`, `admin.tsx:563`) | Current and proposed bio render as `basic` markdown, with the raw source under a `<details>` "Show source". Rendered links hide their URL, and the approver needs to see where a link points. |

### 7. Typography

Add `@tailwindcss/typography` as a dev dependency and `@plugin "@tailwindcss/typography";` to `src/styles/global.css`. This fixes the news and About pages as well. The `.prose-article` block in `global.css:265` has no users; it is left alone and noted in the PR.

## Testing

- `src/lib/markdown.test.ts`:
  - `basic` escapes ATX and setext headings, blockquotes, code, tables, hr, images, codespans, strikethrough and raw HTML, each wrapped so it does not merge with its neighbours.
  - `full` output is unchanged for the existing news fixtures.
  - `markdownToPlainText` drops syntax and keeps link text.
  - A plain-text bio with single newlines and blank lines renders with the same breaks.
- Workers tests:
  - A synopsis with `**x**` renders `<strong>` on the show page, and plain `x` in the home hero and the meta description.
  - A bio with `# heading` renders the `#` as text on the member page.
  - A bio or synopsis over 2,000 characters is rejected.
  - News keeps its existing XSS assertions.
- `src/client/editor.test.ts` (happy-dom):
  - Mounting hides the textarea, drops `required`, and seeds the editor from the textarea's value.
  - An edit writes markdown back to the textarea.
  - A `basic` editor drops a pasted heading.
  - A `full` source containing a table, and a `basic` source containing `# Hi` or `> quote`, do not mount the editor.
  - Over 2,000 characters of markdown blocks submit with the inline message.
  - **Plain text survives:** a multi-line plain bio and a multi-paragraph synopsis pass through load, one edit and an undo, then `getMarkdown()`, and come back byte-identical. The seed data is generated and gitignored, so the test uses a synopsis shaped like it. Prose with literal `*`, `_` and `#` comes back with `*` and `_` escaped, so that case, and formatted markdown in general, is only required to render the same.
- Manual: `npm run dev`, edit a news post, a show and a bio in the browser, submit, and check the public page.

## Risks

- **Round-trip drift.** Once someone edits, the whole document is re-serialized. Two things are unverified:
  - How `@tiptap/markdown` treats single newlines. The site renders with `breaks: true`, so existing bios may rely on a single newline being a line break, and it must not collapse to a space on save.
  - Whether Tiptap emits `update` on initial content load.
  The plan's first task is a spike that answers both and lands the round-trip test. If single newlines do not survive, the editor pre-processes them into hard breaks on load. Cosmetic normalization (`*` to `_`, list markers) is acceptable.
- **Bundle size.** Roughly 100 to 150 KB gzipped, admin pages only.
