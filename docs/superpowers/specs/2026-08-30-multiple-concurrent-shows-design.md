# Multiple concurrent shows

**Date:** 2026-08-30
**Status:** Approved, ready for planning

## Problem

The site promotes exactly one production at a time. The 2026-2027 season has four: a fall show, two early spring shows staged by separate companies, and a late spring show. The two early spring productions run in overlapping windows, so at least two shows are simultaneously worth promoting — a state the site cannot represent.

The four shows are four independent productions with their own titles, scripts, casts, and performance dates. Nothing about the data model needs to change to hold them: `shows`, `show_performances`, `show_cast`, `show_crew`, `show_gallery_images`, and `sponsors` are already keyed per show. What is hardcoded is promotion.

The single-show assumption lives in five places:

- `shows.is_current`, a boolean read by `getCurrentShow` with `.where(eq(shows.isCurrent, true)).limit(1)` (`src/db/queries.ts:62`).
- `setFeaturedShow` (`src/services/shows.ts:152`), which enforces exclusivity by clearing the flag on every other row before setting it on one.
- The home page hero, built around a single show object (`src/routes/home.tsx:16`).
- `/shows/current`, which 302s to that one show (`src/routes/shows.tsx:32`), linked from Header (`src/components/Header.tsx:14`) and Footer (`src/components/Footer.tsx:21`) as "Current Show".
- `getPastShows` (`src/db/queries.ts:104`), which defines past as `NOT is_current OR the run has ended` — so every show that is not the featured one is archive.

## Goals

Promote any number of concurrent productions, distinguish the two early spring companies from each other, and give a visitor one page that shows the whole season. Do it without breaking URLs already shared for shows that have sold tickets.

## Non-goals

A school-year field. A fall 2026 show is `year: 2026` and the spring 2027 shows are `year: 2027`, so the archive groups by calendar year rather than school year. Nothing in this design needs school-year grouping — "this season" is derived from performance dates — so the field is left out deliberately.

Double-casting a single production. The two early spring shows are separate productions, not one production performed by two casts, so `show_cast` needs no company dimension.

## Design

### 1. Schema

One migration, producing this SQL.

```sql
ALTER TABLE shows RENAME COLUMN is_current TO is_announced;
ALTER TABLE shows ADD COLUMN company TEXT;
DROP INDEX idx_shows_current;
CREATE INDEX idx_shows_announced ON shows(is_announced);
```

Generate it with `npm run db:generate` rather than writing the file by hand. Drizzle-kit cannot tell a rename from a drop-plus-add, so it prompts: answer that `is_announced` is **renamed from** `is_current`, not created. Answering "created" emits a drop and an add, which discards the flag on every existing row.

The generated file must be checked before it is applied. It should contain `ALTER TABLE ... RENAME COLUMN`, and `drizzle/meta/0004_snapshot.json` and `drizzle/meta/_journal.json` must both be updated alongside it. Every migration in `drizzle/` has a matching snapshot, and a migration that skips that bookkeeping leaves the next `db:generate` diffing against a snapshot that still holds `is_current` — so it emits a spurious drop and re-add of the column. If drizzle-kit will not produce the rename, the SQL and the snapshot both have to be hand-written; the SQL alone is not enough.

The rename is load-bearing. The column was always an editorial "promote this" choice rather than a statement of fact, and both `src/db/queries.ts:29` and `src/lib/dates.ts:38` already carry comments about it drifting — the spring 2026 production stayed flagged current for five months after closing. Renaming it to what it means forces the compiler to walk every call site, and `is_announced` no longer implies uniqueness the way `is_current` does.

`is_highlighted` is untouched. It still orders the past-productions row on the home page.

The rename is scoped to `shows`. `isCurrent` is also a field on member offices — derived from `endYear === null` at `queries.ts:218` and read in `members.tsx` and `offices.workers-test.ts` — and has nothing to do with productions. A project-wide find and replace would corrupt it.

### 2. Company vocabulary

```ts
/**
 * Which company staged a production.
 *
 * NULL for a production the club stages as one group - the fall and late
 * spring shows - and set only when a slot is split, as early spring is.
 *
 * The slugs are provisional; the club has not settled on what to call the two
 * early spring companies. Display text is deliberately not the stored value,
 * so renaming JV to whatever is chosen is an edit to SHOW_COMPANY_LABEL and
 * nothing else. Only replacing a slug needs a migration.
 */
export const SHOW_COMPANY = { Jv: 'jv', Varsity: 'varsity' } as const;
export type ShowCompany = (typeof SHOW_COMPANY)[keyof typeof SHOW_COMPANY];

export const SHOW_COMPANY_LABEL: Record<ShowCompany, string> = {
  jv: 'JV',
  varsity: 'Varsity',
};
```

This matches how every other vocabulary in the codebase is expressed — `SHOW_CAST_TIER`, `SPONSOR_TIER`, `SPIRIT_WEAR_CATEGORY`, `MEMBER_VISIBILITY`, `NEWS_CATEGORY` are all const objects stored as text.

`Record<ShowCompany, string>` makes the compiler reject a company with no label, so the two cannot drift apart. Nothing renders a raw slug: the badge, the admin dropdown, and the show page all read `SHOW_COMPANY_LABEL`.

### 3. Show states

`is_announced` crossed with the performance dates yields three public states. Every combination is covered, so no row can be stranded in a state nothing renders.

| | no dates, or last date is today or later | all dates in the past |
|---|---|---|
| **announced** | Upcoming | Past |
| **not announced** | Draft — appears nowhere public | Past |

`getCurrentShow` is replaced by `getPromotedShows(db)`, returning the Upcoming set ordered by first performance date ascending, with dateless shows sorted last. `getPastShows` becomes "has at least one performance and the last one is in the past", ordered by year descending, then last performance descending, then title. The null guard matters: phrased as "every date is in the past" it is vacuously true of a show with no dates at all, which would drag dateless drafts into the archive and the sitemap and quietly defeat the draft rule. It matches the existing `lastPerformanceDate IS NOT NULL AND < today` guard at `queries.ts:107`. The current ordering is `desc(shows.year)` alone, which is ambiguous the moment one year holds four shows.

Both queries project `firstPerformance` and `lastPerformance` as correlated subqueries, the same shape as the existing `lastPerformanceDate` at `queries.ts:39`. They need those columns to order by regardless, and projecting them is also what keeps the card date line off an N+1: no card fetches its own performances. `getPerformances` stays a single call, for the hero and the show page, which need the whole schedule rather than its endpoints.

`getLastClosedAnnouncedShow(db)` returns the single most recently closed announced show, for the home page fallback in section 4. It needs its own announced filter and cannot reuse `getPastShows`, which by then includes unannounced past shows.

A show with no performance dates yet is legitimately announceable — the club announces a title before the schedule is locked — and renders as "Dates to be announced".

`formatShowDates([])` returns an empty string (`src/lib/dates.ts:18`), so the fallback text has to come from somewhere. That function already reads only the earliest and latest date out of the list it is handed, so it splits: `formatDateRange(first, last)` does the formatting, `formatShowDates(performances)` delegates to it and keeps its current signature and callers, and a new `showDateLine(first, last)` returns the range or "Dates to be announced" when `first` is null. Cards call `showDateLine` with the projected columns; the hero and the show page keep calling `formatShowDates` with the schedule they already load. One implementation, so the three sites cannot drift into three phrasings.

### 4. Home page

```ts
const [hero, ...alsoThisSeason] = upcoming;
```

The hero markup is unchanged apart from a company badge beside the season in the eyebrow. A new "Also this season" band renders between the hero and the About section, and only when `alsoThisSeason` is non-empty.

When nothing is upcoming, the hero falls back to the most recently closed announced show in its existing "That's a wrap" state. This preserves today's behavior exactly in the single-show case: the morning after closing night the home page still names the show that just ran, rather than emptying out.

`homePastShows` currently filters out `currentShow.id` to avoid listing the hero twice. It now filters out every promoted show id.

### 5. Routes and navigation

- **New `GET /shows`** — an Upcoming section over a Past section.
- **`GET /shows/past`** — 301 to `/shows`. Permanent, because it is an indexed URL being consolidated rather than a temporary move.
- **`GET /shows/current`** — 302 to the soonest upcoming show, or to `/shows` when nothing is upcoming. Links already shared still land on a show.
- **`GET /shows/:slug`** — `show.isCurrent && !closed` becomes `show.isAnnounced && !closed` in **both** places it appears: the hero gradient (`shows.tsx:108`) and the Get Tickets button (`shows.tsx:162`). The second is a deliberate behavior change — every announced running show now offers its own ticket link, where previously only the one featured show did. That is the point of the change, since concurrent productions sell tickets concurrently. A company badge is added.

**Navigation.** Header's "Shows" is already a parent item with two children, `Current Show` and `Past Shows` (`src/components/Header.tsx:11-16`). It collapses to a plain top-level link to `/shows` with no children: with one index page there is nothing left for a dropdown to hold, and a "Past Shows" child pointing at a 301 would be worse than none. Footer's two quick links (`src/components/Footer.tsx:21-22`) collapse to one "Shows" entry the same way.

**Internal links to `/shows/past`.** Three more exist and all move to `/shows`, so no in-app link bounces through the permanent redirect: the "Browse Past Shows" button in the closed-run hero (`home.tsx:87`), the "All shows" link below the past-productions row (`home.tsx:289`), and "Browse Shows" on the 404 page (`system.tsx:500`). The `/shows/current` fallback redirect at `shows.tsx:33` currently targets `/shows/past` and moves too.

### 6. Draft gate

`/shows/:slug` calls `getShow` with no visibility check, so an unannounced show is publicly reachable by URL today. That was low-risk with one staged production; with four a year and more records sitting in the admin ahead of announcement, it is not. The route returns 404 for a draft — a show that is not announced and whose dates are not all in the past.

Past shows stay reachable regardless of the flag, so archiving never breaks an old link.

### 7. Shared show card

A new `src/components/ShowCard.tsx`, used by the home page strip, the `/shows` upcoming list, and the past grid. Two near-duplicate card blocks are already inline in `home.tsx` and `shows.tsx`; without consolidating, this change adds a third. The card renders poster, company badge, title, season, and either the date range or "Dates to be announced".

### 8. Admin

`setFeaturedShow` becomes `setAnnounced(db, actor, id, announced)`: a single-row update with no clear-all-others write, and an audit diff of `{ isAnnounced: { before, after } }`. This is simpler than what it replaces — the current function writes a `featuredShow` diff of show ids because the boolean it was actually setting would have misdescribed the change.

The shows list at `/admin/shows` gains a derived status column (Draft, Upcoming, Closed) and a company column, replacing the current featured/featured-run-over badge. The show detail "Home page" panel becomes an announce toggle, and its copy loses "only one can be".

`ShowInput` gains `company: ShowCompany | null`, and the create and edit forms gain a select offering None plus each `SHOW_COMPANY_LABEL` entry.

`createShow` sets `isCurrent: false` on insert (`src/services/shows.ts:71`) and becomes `isAnnounced: false`. Its doc comment already explains why a new show is not promoted — creating the record and announcing it are separate decisions — and that reasoning survives the rename intact.

`POST /admin/shows/:id/feature` (`admin.tsx:4048`) is renamed to `POST /admin/shows/:id/announce`, and its `featured` form field to `announced`. It is an admin-only form target with no external inbound links, so the path can change outright rather than being kept as a redirect.

Every one of these writes goes through `writeWithAudit`, as all mutations in this codebase do.

### 9. Sitemap

`src/routes/system.tsx` builds the sitemap from `getPastShows` plus `getCurrentShow`. Both collapse into `getIndexableShows` — announced or past, which is everything except drafts. `/shows` is added to the static paths and `/shows/past` is removed, since it is now a redirect.

### 10. Seed and migration tooling

`seed/content.sql`, `scripts/build-seed.mjs:181`, `scripts/build-seed.mjs:195`, and `scripts/verify-seed.mjs:173` all name `is_current` or `isCurrent` and need the rename to keep working. `build-seed.mjs` reads the archived Astro site at `../fairportdrama` and is only re-run for a fresh import, so this is a keep-it-compiling change rather than a functional one.

All four seeded shows have performance rows, so the new date-driven rules strand nothing on an existing database.

## Testing

Two existing suites assert exactly the behavior this design removes and go red the moment `setAnnounced` lands. They are rewritten, not extended:

- `src/services/shows.workers-test.ts` — "is exclusive, so the home page never has to pick between two" (`:135`) becomes its inverse: announcing a second show leaves the first announced. "records which show replaced which" (`:155`) asserts a `featuredShow: { before, after }` diff that no longer exists and becomes an `isAnnounced` diff. "can clear the feature entirely" (`:143`) becomes un-announcing one show.
- `src/routes/admin-pages.workers-test.ts` — the featured-run-over badge assertion (`:313`) becomes the new status column, and the "not featured on the home page until you say so" copy (`:361`) becomes whatever the announce toggle says.

Extending the existing workers suites — `src/db/show-state.workers-test.ts`, `src/routes/admin-shows.workers-test.ts`, `src/routes/home-past-shows.workers-test.ts`, `src/routes/public-pages.workers-test.ts`, `src/routes/happy-paths.workers-test.ts`:

- Announcing a second show does not un-announce the first. This is the regression the whole change exists to prevent.
- Two announced upcoming shows: the soonest heroes, the other appears in the band.
- Three announced upcoming shows: hero plus two cards.
- An announced show with no performance dates sorts after dated ones and renders "Dates to be announced".
- Every announced show closed: the wrap hero renders, the band does not.
- A draft show appears on neither the home page, nor `/shows`, nor the sitemap, and `/shows/:slug` returns 404 for it.
- A past show remains reachable at `/shows/:slug` whether or not it is announced.
- Past shows within one year order by last performance date descending.
- Two concurrent announced running shows each render their own Get Tickets link on their own show page.
- `/shows/current` and `/shows/past` redirect as specified.
- No rendered page links to `/shows/past` or `/shows/current`; the nav points at `/shows`.

A unit test asserts every `SHOW_COMPANY` value has a `SHOW_COMPANY_LABEL` entry, so a company cannot ship without a label.

## Files touched

```
drizzle/                          new migration
src/db/schema/content.ts          is_announced, company, SHOW_COMPANY, SHOW_COMPANY_LABEL
src/db/queries.ts                 getPromotedShows, getPastShows, getIndexableShows
src/services/shows.ts             setAnnounced, ShowInput.company
src/routes/home.tsx               hero from getPromotedShows, "Also this season" band
src/routes/shows.tsx              /shows index, redirects, draft gate, company badge
src/routes/admin.tsx              status and company columns, announce toggle, company select
src/routes/system.tsx             sitemap from getIndexableShows
src/components/Header.tsx         "Shows" -> /shows
src/components/Footer.tsx         "Shows" -> /shows
src/components/ShowCard.tsx       new, shared by home band and both /shows sections
src/lib/dates.ts                  showDateLine helper
seed/content.sql                  column rename
scripts/build-seed.mjs            column rename
scripts/verify-seed.mjs           column rename
```

## Open question deferred

What the two early spring companies are actually called. The slugs `jv` and `varsity` are placeholders. Changing only the display names is a one-line edit to `SHOW_COMPANY_LABEL`; changing the slugs needs a one-statement `UPDATE` migration.
