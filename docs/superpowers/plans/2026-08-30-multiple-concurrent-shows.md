# Multiple Concurrent Shows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the site promote any number of concurrent productions instead of exactly one, so the 2026-2027 season's four shows — including two that run in overlapping windows — can all be announced at once.

**Architecture:** The exclusive `shows.is_current` flag becomes a non-exclusive `is_announced`. Public state is then derived by crossing that flag with each show's performance dates, yielding Upcoming, Past, and Draft. The home page heroes the soonest upcoming show and lists the rest in a band; a new `/shows` index replaces the Current/Past navigation dropdown. A nullable `company` column distinguishes the two early spring productions, with its display text kept out of the stored value so renaming costs no migration.

**Tech Stack:** Hono JSX on Cloudflare Workers, D1 via Drizzle ORM, Better Auth, Tailwind, Luxon, Vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-08-30-multiple-concurrent-shows-design.md`

---

## Before you start

Read the spec. It explains *why* each of these changes is shaped the way it is, and several of them look arbitrary without it.

Two rules this codebase holds to, which you must not break:

**Every mutation is audited** through `writeWithAudit`, in the same D1 batch as the change. D1 has no interactive transactions, so the audit row is a statement the caller batches rather than a side effect it can forget.

**Member visibility is enforced in the query layer**, not in templates. `toPublicMember` decides what leaves the database. You are not touching member queries in this plan, but do not add a code path that reads `members` directly.

Two test suites exist and are run separately:

```bash
npm run test:unit         # pure functions, node, *.test.ts
npm run test:integration  # real workerd and a real D1, *.workers-test.ts
npm run typecheck         # wrangler types && tsc --noEmit
```

`npm test` runs both. Integration tests are slow; while iterating on one file, use `npx vitest run --config vitest.workers.config.ts <path>`.

## File structure

| File | Responsibility after this plan |
|---|---|
| `drizzle/0004_*.sql` + `drizzle/meta/` | The rename, the `company` column, the index swap |
| `src/db/schema/content.ts` | `isAnnounced`, `company`, `SHOW_COMPANY` and its type |
| `src/lib/dates.ts` | `formatDateRange`, `showDateLine`; `formatShowDates` deleted |
| `src/db/queries.ts` | `getPromotedShows`, `getPastShows`, `getLastClosedAnnouncedShow`, `getIndexableShows`, `getShow` with a draft flag |
| `src/services/shows.ts` | `setAnnounced` replaces `setFeaturedShow`; `ShowInput.company`; `SHOW_COMPANY_LABEL`, `isShowCompany` |
| `src/components/ShowCard.tsx` | New. The one card used by the home band and both `/shows` sections |
| `src/routes/shows.tsx` | `/shows` index, redirects, draft gate, company badge |
| `src/routes/home.tsx` | Hero from the promoted list, "Also this season" band |
| `src/components/Header.tsx`, `Footer.tsx` | Collapsed nav |
| `src/routes/admin.tsx` | Status and company columns, announce toggle, company select |
| `src/routes/system.tsx` | Sitemap from `getIndexableShows` |

---

## Task 1: Schema, migration, and the company vocabulary

**Files:**
- Modify: `src/db/schema/content.ts`
- Create: `drizzle/0004_multiple_concurrent_shows.sql`
- Modify: `drizzle/meta/_journal.json`, `drizzle/meta/0004_snapshot.json` (both generated)
- Modify: `seed/content.sql`, `scripts/build-seed.mjs`, `scripts/verify-seed.mjs`
- Test: `src/services/show-company.test.ts` (new)

- [ ] **Step 1: Write the failing test for the label map**

Create `src/services/show-company.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SHOW_COMPANY } from '~/db/schema/content';
import { SHOW_COMPANY_LABEL } from './shows';

describe('show companies', () => {
  it('gives every company a display label', () => {
    for (const slug of Object.values(SHOW_COMPANY)) {
      expect(SHOW_COMPANY_LABEL[slug]).toBeTruthy();
    }
  });

  it('never leaks a slug as display text', () => {
    for (const [slug, label] of Object.entries(SHOW_COMPANY_LABEL)) {
      expect(label).not.toBe(slug);
    }
  });
});
```

The second test is the point of the whole indirection: the slugs are provisional, so nothing may render one.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/services/show-company.test.ts`
Expected: FAIL — `SHOW_COMPANY` is not exported from `~/db/schema/content`.

- [ ] **Step 3: Add the vocabulary to the schema**

In `src/db/schema/content.ts`, directly above the `shows` table:

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
```

Then in `src/services/shows.ts`, below `DEFAULT_VENUE`:

```ts
export const SHOW_COMPANY_LABEL: Record<ShowCompany, string> = {
  [SHOW_COMPANY.Jv]: 'JV',
  [SHOW_COMPANY.Varsity]: 'Varsity',
};

/**
 * Whether a submitted value is a company.
 *
 * `$type<ShowCompany>()` is a compile-time assertion and the column is plain
 * TEXT with no CHECK, so a cast at the form boundary would let any string
 * into the database. Mirrors `isNewsCategory` in `./news.ts`.
 */
export const isShowCompany = (v: string): v is ShowCompany =>
  Object.values(SHOW_COMPANY).includes(v as ShowCompany);
```

The split is the file's own convention: every other vocabulary here — `SPONSOR_TIER`, `SPIRIT_WEAR_CATEGORY`, `NEWS_CATEGORY`, `MEMBER_VISIBILITY`, `SHOW_CAST_TIER` — keeps the const object and type in the schema and puts the label record and type guard in the service that owns them (`src/services/catalog.ts:245`, `src/services/news.ts:168`). Routes import the labels from the service.

`Record<ShowCompany, string>` is load-bearing: it makes the compiler reject a company added without a label.

- [ ] **Step 4: Change the shows table**

In the same file, inside `sqliteTable('shows', ...)`, replace the `isCurrent` field and add `company`:

```ts
    isAnnounced: integer('is_announced', { mode: 'boolean' }).notNull().default(false),
    company: text('company').$type<ShowCompany>(),
```

And in the index callback, replace `idx_shows_current`:

```ts
  (t) => [index('idx_shows_year').on(t.year), index('idx_shows_announced').on(t.isAnnounced)],
```

Do **not** find-and-replace `isCurrent` across the project. Member offices has its own unrelated derived `isCurrent` (`src/db/queries.ts:218`, read in `src/routes/members.tsx:302`) which a global replace would corrupt.

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/services/show-company.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Generate the migration**

Run: `npx drizzle-kit generate --name multiple_concurrent_shows`

Drizzle-kit cannot tell a rename from a drop-plus-add, so it prompts. **Answer that `is_announced` is renamed from `is_current`**, and that `company` is created. Answering "created" for `is_announced` emits a drop and an add, which discards the flag on every existing row.

The prompt is an interactive select list. If the command blocks in a non-interactive shell, run it in a terminal — do not try to pipe an answer, since a blind newline selects "create column", which is the data-losing choice.

Confirm it wrote three things: `drizzle/0004_multiple_concurrent_shows.sql`, `drizzle/meta/0004_snapshot.json`, and a new entry in `drizzle/meta/_journal.json`.

- [ ] **Step 7: Check the SQL, and fix it if drizzle-kit did not offer the rename**

Open `drizzle/0004_multiple_concurrent_shows.sql`. It should read:

```sql
ALTER TABLE `shows` RENAME COLUMN `is_current` TO `is_announced`;--> statement-breakpoint
ALTER TABLE `shows` ADD `company` text;--> statement-breakpoint
DROP INDEX `idx_shows_current`;--> statement-breakpoint
CREATE INDEX `idx_shows_announced` ON `shows` (`is_announced`);
```

If instead it drops `is_current` and adds `is_announced`, replace the file's contents with exactly the SQL above. The generated snapshot is still correct either way — a snapshot describes the schema's end state, not the route taken to it — so only the SQL needs the edit. Keep the `--> statement-breakpoint` separators; drizzle splits on them.

- [ ] **Step 8: Verify the snapshot matches the schema**

Run: `npx drizzle-kit generate`
Expected: `No schema changes, nothing to migrate` — proving the hand-edited SQL and the generated snapshot describe the same end state. If it wants to emit a 0005, the snapshot is wrong; fix it before going further.

- [ ] **Step 9: Apply it locally and confirm the data survived**

```bash
npm run db:migrate:local
npx wrangler d1 execute fairport-drama-db --local --command "SELECT id, is_announced, company FROM shows"
```

Expected: every row present, `the-lightning-thief-2026` still has `is_announced` = 1 (it was the featured show), the rest 0, and `company` NULL throughout. If `is_announced` is 0 everywhere, the rename became a drop-and-add — go back to step 7.

- [ ] **Step 10: Rename the column in the seed and its tooling**

Three mechanical renames, so `npm run seed:apply:local` keeps working:

- `seed/content.sql` — `is_current` to `is_announced` in the four `INSERT INTO shows` column lists (lines 283, 342, 419, 503). This file is **gitignored** (`.gitignore:25`), so the edit lives only in your working tree and `git add seed/content.sql` silently does nothing. That is fine: it is a generated artifact, and `build-seed.mjs` — which is committed — regenerates it correctly. Anyone holding a stale local copy will hit `no column named is_current` on `seed:apply:local` after migrating, and regenerating fixes it.
- `scripts/build-seed.mjs:181` — `is_current` to `is_announced` in the column list; `:195` — `data.isCurrent` to `data.isAnnounced ?? data.isCurrent ?? false`, since the archived Astro source it reads still uses the old key.
- `scripts/verify-seed.mjs:173` — `s.data.isCurrent` to `s.data.isAnnounced ?? s.data.isCurrent`.

`build-seed.mjs` reads the archived Astro site at `../fairportdrama` and only runs for a fresh import, so this is a keep-it-working change rather than a functional one.

- [ ] **Step 11: Typecheck**

Run: `npm run typecheck`
Expected: FAIL, and that is correct at this point. Every `shows.isCurrent` reader is now a compile error — `src/db/queries.ts`, `src/services/shows.ts`, `src/routes/{home,shows,admin,system}.tsx`, and several test files. That error list is your work queue for tasks 3 through 10. Read it and confirm it holds no surprises beyond those files.

- [ ] **Step 12: Commit**

```bash
git add src/db/schema/content.ts src/lib/show-company.test.ts drizzle/ seed/content.sql scripts/build-seed.mjs scripts/verify-seed.mjs
git commit -m "feat(shows): rename is_current to is_announced and add company

The flag was always an editorial choice rather than a statement of fact,
and it drifted - the spring 2026 production stayed flagged current for
five months after closing. Renaming it drops the implication that only
one show can hold it, which is what the coming season needs."
```

The tree does not typecheck at this commit. That is deliberate: the schema change and its fallout are separately reviewable, and splitting them keeps each diff readable.

---

## Task 2: Date range formatting

**Files:**
- Modify: `src/lib/dates.ts`
- Test: `src/lib/dates.test.ts`

Cards need to show a date range, but no card in this codebase fetches performances and none should start — see task 3. So the formatter has to work from two endpoint dates rather than a list. `formatShowDates` already reads only the earliest and latest date out of the list it is handed, and its only two callers are being changed anyway, so it is replaced rather than kept.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/dates.test.ts`:

```ts
describe('formatDateRange', () => {
  it('collapses a single date', () => {
    expect(formatDateRange('2026-03-05', '2026-03-05')).toBe('Mar 5, 2026');
  });

  it('keeps one month name when the run does not cross months', () => {
    expect(formatDateRange('2026-03-05', '2026-03-07')).toBe('March 5-7, 2026');
  });

  it('names both months when the run crosses one', () => {
    expect(formatDateRange('2026-02-27', '2026-03-01')).toBe('Feb 27 - Mar 1, 2026');
  });
});

describe('showDateLine', () => {
  it('formats a range from the projected endpoints', () => {
    expect(showDateLine('2026-03-05', '2026-03-07')).toBe('March 5-7, 2026');
  });

  it('says so when a show has no dates yet', () => {
    expect(showDateLine(null, null)).toBe('Dates to be announced');
  });
});

```

Add `formatDateRange` and `showDateLine` to the existing import from `./dates` at the top of the file.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/lib/dates.test.ts`
Expected: FAIL — `formatDateRange is not a function`.

- [ ] **Step 3: Split the formatter**

`formatShowDates` has exactly two call sites — `home.tsx:72` and `shows.tsx:138` — and tasks 6 and 7 replace both with `showDateLine`. So this is a replacement, not a split: delete `formatShowDates` rather than leaving it behind as dead code.

In `src/lib/dates.ts`:

```ts
/**
 * A run's dates, from its endpoints.
 *
 * Takes two dates rather than a schedule because the show cards render from
 * columns projected by the query, not from a per-card performance fetch.
 */
export function formatDateRange(first: string, last: string): string {
  const a = DateTime.fromISO(first, { zone: ZONE });
  const b = DateTime.fromISO(last, { zone: ZONE });

  if (first === last) return a.toLocaleString(DateTime.DATE_MED);
  if (a.month === b.month) return `${a.toFormat('MMMM d')}-${b.toFormat('d, yyyy')}`;
  return `${a.toFormat('MMM d')} - ${b.toFormat('MMM d, yyyy')}`;
}

/** A show announced before its schedule is locked still needs a date line. */
export const DATES_TBA = 'Dates to be announced';

export const showDateLine = (first: string | null, last: string | null): string =>
  first && last ? formatDateRange(first, last) : DATES_TBA;

```

Delete `formatShowDates`. Its old single-date branch tested `unique.length === 1`, which after deduplication is exactly `first === last`, so `formatDateRange` reproduces all three of its output shapes. `PerformanceLike` stays — `hasClosed` still takes it.

The existing `describe('formatShowDates')` block in `src/lib/dates.test.ts` tests a function that no longer exists. Convert its cases to `formatDateRange`, passing the first and last date instead of a performance array. Do not simply delete them; they are the only coverage of the month-spanning format.

- [ ] **Step 4: Run the whole unit suite**

Run: `npm run test:unit`
Expected: PASS. The whole suite, not just this file — `formatShowDates` no longer exists, so anything still calling it fails here rather than at task 6.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dates.ts src/lib/dates.test.ts
git commit -m "feat(dates): format a run from its endpoints

Show cards need a date line but must not fetch performances per card,
so the formatter takes the two dates the query already projects."
```

---

## Task 3: The query layer

**Files:**
- Modify: `src/db/queries.ts`
- Test: `src/db/show-state.workers-test.ts`

This is the task the rest of the plan rests on. Four states fall out of `is_announced` crossed with the dates, and every combination is covered so no row lands somewhere nothing renders it:

| | no dates, or last date today or later | all dates past |
|---|---|---|
| **announced** | Upcoming | Past |
| **not announced** | Draft — nowhere public | Past |

- [ ] **Step 1: Rewrite the state tests**

`src/db/show-state.workers-test.ts` currently tests `getCurrentShow` and `getPastShows`. Update its `seedShow` helper to take `isAnnounced` instead of `isCurrent`, then replace the test bodies with:

```ts
describe('getPromotedShows', () => {
  it('returns every announced show that has not closed, soonest first', async () => {
    await seedShow('late', true, [iso(60), iso(61)]);
    await seedShow('soon', true, [iso(5), iso(6)]);
    await seedShow('draft', false, [iso(10)]);

    const promoted = await getPromotedShows(db());
    expect(promoted.map((s) => s.id)).toEqual(['soon', 'late']);
  });

  it('sorts a show with no dates yet after every dated one', async () => {
    await seedShow('dated', true, [iso(30)]);
    await seedShow('undated', true, []);

    const promoted = await getPromotedShows(db());
    expect(promoted.map((s) => s.id)).toEqual(['dated', 'undated']);
  });

  it('drops a show the day after it closes', async () => {
    await seedShow('closed', true, [iso(-4), iso(-3)]);

    expect(await getPromotedShows(db())).toEqual([]);
  });

  it('projects the endpoints the cards render', async () => {
    await seedShow('run', true, [iso(5), iso(7), iso(6)]);

    const [show] = await getPromotedShows(db());
    expect(show!.firstPerformance).toBe(iso(5));
    expect(show!.lastPerformance).toBe(iso(7));
  });
});

describe('getPastShows', () => {
  it('holds closed shows whether or not they are announced', async () => {
    await seedShow('announced-closed', true, [iso(-10)]);
    await seedShow('archived', false, [iso(-20)]);

    const past = await getPastShows(db());
    expect(past.map((s) => s.id).sort()).toEqual(['announced-closed', 'archived']);
  });

  it('never holds a show with no dates at all', async () => {
    await seedShow('draft', false, []);

    expect(await getPastShows(db())).toEqual([]);
  });

  it('orders within a year by when the run ended', async () => {
    await seedShow('fall', false, [iso(-200)]);
    await seedShow('spring', false, [iso(-20)]);

    const past = await getPastShows(db());
    expect(past.map((s) => s.id)).toEqual(['spring', 'fall']);
  });
});

describe('getLastClosedAnnouncedShow', () => {
  it('picks the most recent closed announced show', async () => {
    await seedShow('older', true, [iso(-100)]);
    await seedShow('newer', true, [iso(-5)]);
    await seedShow('unannounced', false, [iso(-3)]);

    const show = await getLastClosedAnnouncedShow(db());
    expect(show!.id).toBe('newer');
  });
});

describe('getIndexableShows', () => {
  it('holds announced and past shows but never a draft', async () => {
    await seedShow('upcoming', true, [iso(5)]);
    await seedShow('past', false, [iso(-5)]);
    await seedShow('draft', false, [iso(5)]);

    const ids = (await getIndexableShows(db())).map((s) => s.id).sort();
    expect(ids).toEqual(['past', 'upcoming']);
  });
});

describe('getShow', () => {
  it('marks an unannounced future show as a draft', async () => {
    await seedShow('staged', false, [iso(20)]);

    expect((await getShow(db(), 'staged'))!.isDraft).toBe(true);
  });

  it('does not mark a past show as a draft, announced or not', async () => {
    await seedShow('old', false, [iso(-20)]);

    expect((await getShow(db(), 'old'))!.isDraft).toBe(false);
  });
});
```

The "never holds a show with no dates at all" test guards a subtle trap: phrased as "every date is in the past", the past rule is vacuously true of a dateless show, which would drag drafts into the archive and the sitemap and silently defeat the draft gate.

Update the file's imports to the new function names.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --config vitest.workers.config.ts src/db/show-state.workers-test.ts`
Expected: FAIL — `getPromotedShows is not exported`.

- [ ] **Step 3: Add the first-performance projection and a shared column set**

In `src/db/queries.ts`, beside the existing `lastPerformanceDate`:

```ts
const firstPerformanceDate = sql<string | null>`(
  SELECT MIN(p.date) FROM show_performances p WHERE p.show_id = ${sql.raw('"shows"."id"')}
)`;
```

The `sql.raw('"shows"."id"')` is not a stylistic choice — read the comment above `lastPerformanceDate` before touching it. Drizzle renders an interpolated `${shows.id}` as an unqualified `"id"`, which inside the subquery binds to `show_performances.id` and silently correlates nothing.

Then the shared projection, so four queries cannot drift apart:

```ts
const showColumns = {
  id: shows.id,
  title: shows.title,
  season: shows.season,
  year: shows.year,
  company: shows.company,
  venue: shows.venue,
  synopsis: shows.synopsis,
  ticketUrl: shows.ticketUrl,
  posterImageId: shows.posterImageId,
  heroImageId: shows.heroImageId,
  ogImageId: shows.ogImageId,
  isAnnounced: shows.isAnnounced,
  isHighlighted: shows.isHighlighted,
  firstPerformance: firstPerformanceDate,
  lastPerformance: lastPerformanceDate,
};
```

Do not export a `ShowRow` alias for this shape. Nothing in the plan needs one — `shows.tsx` derives its card type inline from the query's return type — and an exported alias no caller uses is dead surface.

- [ ] **Step 4: Replace getCurrentShow with getPromotedShows**

Delete `getCurrentShow` and its `ShowState` type. In its place:

```ts
/**
 * Whether a run has finished, as a WHERE fragment.
 *
 * A function, not a constant. `today()` bound once at module load would
 * freeze the date for the life of the isolate, so a Worker that survived
 * midnight would compare against yesterday - the same drift this change
 * exists to remove.
 */
const closed = () =>
  sql`${lastPerformanceDate} IS NOT NULL AND ${lastPerformanceDate} < ${today()}`;

/**
 * Announced shows whose runs have not ended, soonest first.
 *
 * Replaces the single featured show. Two productions can now be promoted at
 * once - the club stages a JV and a Varsity show in overlapping windows -
 * so the home page takes the head of this list as its hero and lists the
 * tail beneath it.
 *
 * A show announced before its schedule is locked has no dates and sorts
 * last, rather than sorting as though it were happening today.
 */
export async function getPromotedShows(db: DB) {
  return db
    .select(showColumns)
    .from(shows)
    .where(and(eq(shows.isAnnounced, true), sql`NOT (${closed()})`))
    .orderBy(
      sql`${firstPerformanceDate} IS NULL`,
      sql`${firstPerformanceDate} ASC`,
      asc(shows.title),
    );
}

/**
 * The most recently closed announced show, for the home page's wrap state.
 *
 * Cannot reuse getPastShows: that now includes shows nobody ever announced,
 * and the morning after closing night the home page should name the show
 * that just ran rather than whatever is deepest in the archive.
 */
export async function getLastClosedAnnouncedShow(db: DB) {
  const [row] = await db
    .select(showColumns)
    .from(shows)
    .where(and(eq(shows.isAnnounced, true), closed()))
    .orderBy(sql`${lastPerformanceDate} DESC`)
    .limit(1);

  return row ?? null;
}
```

`ORDER BY <expr> IS NULL` sorts non-null first, because SQLite renders false as 0.

- [ ] **Step 5: Rewrite getPastShows and getShow, and add getIndexableShows**

```ts
/**
 * Shows that have finished, newest first.
 *
 * "Finished" requires at least one performance date. Phrased as "every date
 * is in the past" it would be vacuously true of a show with no dates, which
 * would pull unannounced drafts into the archive and the sitemap.
 *
 * Ordered by when the run ended, not by `year`. `year` is hand-entered and
 * can disagree with the dates - a spring 2027 show belonging to the
 * 2026-2027 season is easily entered as 2026 - so sorting by it first would
 * group the archive wrongly and leave the date sort ordering within that
 * mistake. Every row here has a last performance; that is what put it here.
 */
export async function getPastShows(db: DB) {
  return db
    .select(showColumns)
    .from(shows)
    .where(closed())
    .orderBy(sql`${lastPerformanceDate} DESC`, asc(shows.title));
}

/** Every show with a public page: announced, or finished. Not drafts. */
export async function getIndexableShows(db: DB) {
  return db
    .select({ id: shows.id })
    .from(shows)
    .where(or(eq(shows.isAnnounced, true), closed()));
}

/**
 * One show, with whether it is still a draft.
 *
 * A draft is unannounced and unfinished - a record staged in the admin
 * before the club has announced it. `/shows/:slug` 404s for one. A finished
 * show stays reachable whether or not it was ever announced, so archiving
 * never breaks an old link.
 */
export async function getShow(db: DB, id: string) {
  const [row] = await db.select(showColumns).from(shows).where(eq(shows.id, id)).limit(1);
  if (!row) return null;

  const hasClosed = row.lastPerformance !== null && row.lastPerformance < today();
  return { ...row, closed: hasClosed, isDraft: !row.isAnnounced && !hasClosed };
}
```

`getShow` narrows from `db.select()` to `showColumns`, so it no longer returns `createdAt` and `updatedAt`. Its only caller is `src/routes/shows.tsx:88`, which uses neither.

- [ ] **Step 5b: Drop imports the rewrite orphaned**

`getPastShows` no longer sorts by `desc(shows.year)`. Check whether `desc` still has a caller in `queries.ts` before removing it — the news queries may still use it. Same for anything else the deleted `getCurrentShow` was the last user of. Leave imports that are still used.

- [ ] **Step 6: Run the state tests**

Run: `npx vitest run --config vitest.workers.config.ts src/db/show-state.workers-test.ts`
Expected: PASS, all 11.

Note `iso()` derives from the UTC date while `today()` derives from `America/New_York`, so a date one day back is ambiguous between 20:00 ET and midnight. Every "past" date in these tests is at least three days back for that reason.

- [ ] **Step 7: Commit**

```bash
git add src/db/queries.ts src/db/show-state.workers-test.ts
git commit -m "feat(shows): derive show state for any number of concurrent runs

getCurrentShow returned one row; getPromotedShows returns the ordered
set. Both list queries project the run's endpoints, which they need to
sort by anyway and which keeps the cards off a per-card performance
fetch."
```

---

## Task 4: setAnnounced

**Files:**
- Modify: `src/services/shows.ts`
- Test: `src/services/shows.workers-test.ts`

- [ ] **Step 1: Rewrite the exclusivity tests into their inverse**

All four replacement tests below belong inside the existing `describe('featuring a show')` block at `:128`. Its `beforeEach` is what creates both `into-the-woods-2026` and `matilda-2027` (via `createShow` with title `Matilda`, year 2027) and clears `audit_events`. Moved outside that block the tests fail, because `setAnnounced` on a show that does not exist returns `{ changed: false }` and writes nothing. Rename the block to `describe('announcing a show')`.

`src/services/shows.workers-test.ts` currently asserts the behavior being deleted. Replace three tests:

- `:135` "is exclusive, so the home page never has to pick between two"
- `:143` "can clear the feature entirely"
- `:151` "records which show replaced which", whose `:158` assertion expects a `featuredShow: { before, after }` diff that will no longer exist

with:

```ts
  it('leaves the first show announced when a second is announced', async () => {
    await setAnnounced(db(), staff, 'into-the-woods-2026', true);
    await setAnnounced(db(), staff, 'matilda-2027', true);

    const announced = (await db().select().from(shows)).filter((s) => s.isAnnounced);
    expect(announced.map((s) => s.id).sort()).toEqual([
      'into-the-woods-2026',
      'matilda-2027',
    ]);
  });

  it('un-announces one show without touching the others', async () => {
    await setAnnounced(db(), staff, 'into-the-woods-2026', true);
    await setAnnounced(db(), staff, 'matilda-2027', true);
    await setAnnounced(db(), staff, 'matilda-2027', false);

    const announced = (await db().select().from(shows)).filter((s) => s.isAnnounced);
    expect(announced.map((s) => s.id)).toEqual(['into-the-woods-2026']);
  });

  it('records the announcement as a diff on the show itself', async () => {
    await env.DB.exec('DELETE FROM audit_events');
    await setAnnounced(db(), staff, 'into-the-woods-2026', true);

    const [audit] = await audits();
    expect(audit!.diff).toEqual({ isAnnounced: { before: false, after: true } });
    expect(audit!.targetId).toBe('into-the-woods-2026');
  });

  it('does nothing when the show is already in that state', async () => {
    await setAnnounced(db(), staff, 'into-the-woods-2026', true);
    await env.DB.exec('DELETE FROM audit_events');

    expect(await setAnnounced(db(), staff, 'into-the-woods-2026', true)).toEqual({
      changed: false,
    });
    expect(await audits()).toHaveLength(0);
  });
```

The first test is the regression this entire change exists to prevent. Update the file's imports, and rename `isCurrent` to `isAnnounced` in any seed helper it defines.

One plain assertion elsewhere in the file also goes red: `:67`, in `describe('creating a show')`, reads `expect(row!.isCurrent).toBe(false)`. After task 1 that property is `undefined`, so the assertion fails rather than erroring. Rename it to `isAnnounced`, and retitle the test — "does not feature it" becomes "does not announce it".

One more test uses the deleted API and needs a rewrite, not a rename — `:224` `'decides whether the run reads as over'`, in `describe('performance dates')`. It calls `setFeaturedShow` and reads `getCurrentShow(db())!.state`, neither of which survives. Rewrite it against `getShow`, which now carries `closed`:

```ts
  it('decides whether the run reads as over', async () => {
    const id = 'into-the-woods-2026';
    await setAnnounced(db(), staff, id, true);

    await replacePerformances(db(), staff, id, [{ date: '2020-01-01', time: '7:30 PM' }]);
    expect((await getShow(db(), id))!.closed).toBe(true);

    await replacePerformances(db(), staff, id, [{ date: '2099-01-01', time: '7:30 PM' }]);
    expect((await getShow(db(), id))!.closed).toBe(false);
  });
```

The file will not even import until this is done, so Step 5 cannot pass without it.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --config vitest.workers.config.ts src/services/shows.workers-test.ts`
Expected: FAIL — `setAnnounced is not exported`.

- [ ] **Step 3: Replace setFeaturedShow**

In `src/services/shows.ts`, delete `setFeaturedShow` entirely and add:

```ts
/**
 * Announces a show, or withdraws the announcement.
 *
 * One row, no side effects on any other. Its predecessor cleared the flag on
 * every other show first, because the home page could render only one - a
 * season with two concurrent productions makes that rule wrong rather than
 * merely restrictive.
 */
export async function setAnnounced(
  db: DB,
  actor: Actor,
  id: string,
  announced: boolean,
): Promise<{ changed: boolean }> {
  const [current] = await db
    .select({ isAnnounced: shows.isAnnounced })
    .from(shows)
    .where(eq(shows.id, id))
    .limit(1);

  if (!current || current.isAnnounced === announced) return { changed: false };

  await writeWithAudit(
    db,
    actor,
    [
      db
        .update(shows)
        .set({ isAnnounced: announced, updatedAt: new Date().toISOString() })
        .where(eq(shows.id, id)),
    ],
    {
      action: AUDIT_ACTION.ShowUpdated,
      targetKind: AUDIT_ENTITY_KIND.Show,
      targetId: id,
      diff: { isAnnounced: { before: current.isAnnounced, after: announced } },
    },
  );

  return { changed: true };
}
```

The diff is now honest about what it describes. Its predecessor wrote a `featuredShow` diff holding show ids, because the boolean it was actually setting would have misdescribed a change that moved a flag between two rows.

Drop `ne` from the `drizzle-orm` import at the top of the file. Its only use is at `:188`, inside `setFeaturedShow`, which this step deletes — verified, nothing else in the file calls it.

- [ ] **Step 4: Add company to ShowInput**

In the same file, add to `ShowInput`:

```ts
  company: ShowCompany | null;
```

`type ShowCompany` is already imported at the top of this file — the company label and type guard live here, so the import landed with them. Do not add a second one. In `createShow`, change `isCurrent: false` to `isAnnounced: false` and add `company: input.company` to the insert values. `updateShow` iterates `Object.entries(patch)` generically, so it needs no change.

Making `company` required breaks the shared `input` fixture at `src/services/shows.workers-test.ts:29-37`, which eight tests pass to `createShow`. Add `company: null` to it. `tsconfig.json` includes `src/**/*`, so leaving it out fails `npm run typecheck` rather than only the tests.

- [ ] **Step 5: Run the service tests**

Run: `npx vitest run --config vitest.workers.config.ts src/services/shows.workers-test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/shows.ts src/services/shows.workers-test.ts
git commit -m "feat(shows): announce a show without un-announcing the others

setFeaturedShow cleared the flag on every other row to keep the home
page's single hero unambiguous. Two concurrent productions make that
rule wrong, so announcing is now one row and one honest diff."
```

---

## Task 5: The show card

**Files:**
- Create: `src/components/ShowCard.tsx`
- Test: `src/components/ShowCard.test.ts` (new)

Three card renderings are about to exist — the home band, `/shows` upcoming, `/shows` past. Two near-duplicates are already inline in `home.tsx:296-321` and `shows.tsx:52-77`; without consolidating, this change adds a third.

- [ ] **Step 1: Write the failing test**

Typecheck is globally red until task 10, so "no new error in this file" is not a gate you can lean on. Give the card a real one. Components here are tested by rendering to a string — see `src/components/PhotoGallery.test.ts` for the pattern, including the `toString()` cast Hono JSX needs.

Create `src/components/ShowCard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ShowCard, type ShowCardView } from './ShowCard';
import { SHOW_COMPANY } from '~/db/schema/content';

const render = (show: ShowCardView, dates?: boolean) =>
  (ShowCard({ show, dates }) as unknown as { toString(): string }).toString();

const base: ShowCardView = {
  id: 'the-lightning-thief-2026',
  title: 'The Lightning Thief',
  season: 'Spring 2026',
  company: null,
  posterUrl: null,
  firstPerformance: '2026-03-05',
  lastPerformance: '2026-03-07',
};

describe('ShowCard', () => {
  it('shows the company label and never the stored slug', () => {
    const html = render({ ...base, company: SHOW_COMPANY.Jv });

    expect(html).toContain('JV');
    // The slugs are provisional. One reaching a page is the failure this
    // whole label indirection exists to prevent.
    expect(html).not.toContain('>jv<');
  });

  it('renders no badge for a show the whole club stages', () => {
    expect(render(base)).not.toContain('rounded-full');
  });

  it('gives a dateless show a line saying so', () => {
    const html = render({ ...base, firstPerformance: null, lastPerformance: null });

    expect(html).toContain('Dates to be announced');
  });

  it('omits the date line for the archive', () => {
    expect(render(base, false)).not.toContain('March 5-7, 2026');
  });

  it('links to the show', () => {
    expect(render(base)).toContain('href="/shows/the-lightning-thief-2026"');
  });
});
```

- [ ] **Step 2: Write the component**

Create `src/components/ShowCard.tsx`:

```tsx
import { type ShowCompany } from '~/db/schema/content';
import { SHOW_COMPANY_LABEL } from '~/services/shows';
import { showDateLine } from '~/lib/dates';

export interface ShowCardView {
  id: string;
  title: string;
  season: string;
  company: ShowCompany | null;
  posterUrl: string | null;
  firstPerformance: string | null;
  lastPerformance: string | null;
}

/**
 * One production, as a card.
 *
 * Shared by the home page's concurrent-shows band and both sections of the
 * shows index. `dates` is omitted for the archive, where a run that ended
 * years ago is noise next to the season it belongs to.
 */
export const ShowCard = ({ show, dates = true }: { show: ShowCardView; dates?: boolean }) => (
  <a
    href={`/shows/${show.id}`}
    class="group block rounded-xl overflow-hidden ring-1 ring-neutral-200 hover:ring-primary-300 transition-all bg-white"
  >
    <div class="aspect-[16/10] bg-neutral-800">
      {show.posterUrl && (
        <img
          src={show.posterUrl}
          alt=""
          loading="lazy"
          class="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
        />
      )}
    </div>
    <div class="p-5">
      {show.company && (
        <span class="inline-block mb-2 px-2 py-0.5 rounded-full bg-primary-50 text-primary-700 text-xs font-medium">
          {SHOW_COMPANY_LABEL[show.company]}
        </span>
      )}
      <h3 class="font-display font-semibold text-neutral-900 group-hover:text-primary-600 transition-colors">
        {show.title}
      </h3>
      <p class="text-sm text-neutral-500">{show.season}</p>
      {dates && (
        <p class="mt-1 text-sm text-neutral-600">
          {showDateLine(show.firstPerformance, show.lastPerformance)}
        </p>
      )}
    </div>
  </a>
);
```

Note it renders `SHOW_COMPANY_LABEL[show.company]` and never the slug. The slugs are provisional and must not reach a page.

The heading is `h3` because both call sites nest it under a section `h2`.

- [ ] **Step 3: Run the test**

Run: `npx vitest run src/components/ShowCard.test.ts`
Expected: PASS, 5 tests. Then `npm run test:unit` to confirm nothing else moved.

Importing `ShowCard` pulls in `~/services/shows` for `SHOW_COMPANY_LABEL`, which reaches drizzle and the audit helpers. That imports fine under node — `src/services/show-company.test.ts` already does it — but if it does not, say so rather than working around it.

- [ ] **Step 4: Commit**

```bash
git add src/components/ShowCard.tsx src/components/ShowCard.test.ts
git commit -m "feat(shows): add the card the season band and index share"
```

---

## Task 6: The shows index, redirects, and the draft gate

**Files:**
- Modify: `src/routes/shows.tsx`
- Test: `src/routes/public-pages.workers-test.ts`

- [ ] **Step 1: Write the failing route tests**

`src/routes/public-pages.workers-test.ts` does **not** import `app`. It uses `get(path)` from `~/test/session` (which sets `redirect: 'manual'`) and a local `body(path)` at `:39` that asserts a 200 and returns the text. Redirect assertions must use `get`, because `body` throws on a 301.

Add a self-contained describe block so it does not depend on the seeding in the surrounding blocks:

```ts
describe('the shows index', () => {
  const seed = async (
    id: string,
    opts: { announced: boolean; date: string },
  ) => {
    await db().insert(shows).values({
      id,
      title: id,
      season: 'Spring 2027',
      year: 2027,
      synopsis: 'A show.',
      isAnnounced: opts.announced,
    });
    await db()
      .insert(showPerformances)
      .values({ id: `${id}-p`, showId: id, date: opts.date, time: '7:30 PM' });
  };

  beforeEach(async () => {
    await seed('upcoming-show', { announced: true, date: iso(10) });
    await seed('staged-show', { announced: false, date: iso(20) });
    await seed('archived-show', { announced: false, date: iso(-30) });
  });

  it('lists upcoming shows above past ones', async () => {
    const html = await body('/shows');
    expect(html).toContain('Upcoming');
    expect(html.indexOf('Upcoming')).toBeLessThan(html.indexOf('Past Productions'));
  });

  it('redirects the old past-shows URL to the index for good', async () => {
    const res = await get('/shows/past');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/shows');
  });

  it('sends /shows/current to the soonest upcoming show', async () => {
    const res = await get('/shows/current');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/shows/upcoming-show');
  });

  it('404s a draft rather than serving it to anyone holding the URL', async () => {
    expect((await get('/shows/staged-show')).status).toBe(404);
  });

  it('still serves a past show that was never announced', async () => {
    expect((await get('/shows/archived-show')).status).toBe(200);
  });

  it('shows a draft to whoever can edit it, so it can be checked first', async () => {
    const cookie = await signIn('board@example.com', APP_ROLE.Admin);
    expect((await get('/shows/staged-show', cookie)).status).toBe(200);
  });

  it('offers tickets on every announced running show, not just one', async () => {
    await db()
      .update(shows)
      .set({ ticketUrl: 'https://tickets.example.com' })
      .where(eq(shows.id, 'upcoming-show'));
    await seed('second-show', { announced: true, date: iso(14) });
    await db()
      .update(shows)
      .set({ ticketUrl: 'https://tickets.example.com/2' })
      .where(eq(shows.id, 'second-show'));

    expect(await body('/shows/upcoming-show')).toContain('Get Tickets');
    expect(await body('/shows/second-show')).toContain('Get Tickets');
  });
});
```

That last test covers the plan's one deliberate behavior change on the show page. The file already imports `eq`, `shows`, and `showPerformances`; add an `iso` helper if it has none, and add `signIn` to the `~/test/session` import plus `APP_ROLE` from `~/db/schema/governance` for the draft-preview test.

The top-level `beforeEach` at `:149` clears `shows` and `show_performances` between every test, so a self-contained block sees only its own rows — which is what makes the `/shows/current` destination assertion safe to write.

- [ ] **Step 1a: Rename this file's own `isCurrent` seed field**

`seedShow` at `:94` writes `isCurrent: opts.featured`. That column no longer exists, so nothing in this file can pass until it becomes `isAnnounced: opts.featured`. Do it here — the plan originally deferred it to task 11, which is wrong: this file passing is this task's gate.

- [ ] **Step 1b: Repoint the two existing tests that fetch `/shows/past`**

`:301` ("appears in the past shows archive even while still flagged current") and `:313` ("the archive says so rather than showing an empty grid") both call `body('/shows/past')`, which now 301s and makes `body` throw. Change both to `body('/shows')`. Rename the first to drop "flagged current", which is no longer a thing.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --config vitest.workers.config.ts src/routes/public-pages.workers-test.ts`
Expected: FAIL — `/shows` 404s, `/shows/past` returns 200.

- [ ] **Step 3: Replace the current and past routes with the index**

In `src/routes/shows.tsx`, replace the `/shows/current` and `/shows/past` handlers. Register `/shows` before `/shows/:slug` for clarity. (They cannot actually collide — different segment counts — unlike `/admin/shows/new`, where `admin.tsx` does depend on registration order.)

```tsx
showRoutes.get('/shows/current', async (c) => {
  const [next] = await getPromotedShows(getDb(c.env.DB));
  return next ? c.redirect(`/shows/${next.id}`, 302) : c.redirect('/shows', 302);
});

// Permanent: /shows/past was indexed, and it is being folded into /shows
// rather than moved.
showRoutes.get('/shows/past', (c) => c.redirect('/shows', 301));

showRoutes.get('/shows', async (c) => {
  const db = getDb(c.env.DB);
  const images = c.get('images');
  const [upcoming, past] = await Promise.all([getPromotedShows(db), getPastShows(db)]);

  const toCard = (show: (typeof past)[number]) => ({
    id: show.id,
    title: show.title,
    season: show.season,
    company: show.company,
    posterUrl: images.deliveryUrl(show.posterImageId, IMAGE_VARIANT.Poster),
    firstPerformance: show.firstPerformance,
    lastPerformance: show.lastPerformance,
  });

  return c.render(
    <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16 space-y-16">
      {upcoming.length > 0 && (
        <section>
          <h2 class="font-display text-3xl font-bold text-neutral-900 mb-8">Upcoming</h2>
          <div class="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {upcoming.map((show) => (
              <ShowCard show={toCard(show)} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 class="font-display text-3xl font-bold text-neutral-900 mb-3">
          Past Productions
        </h2>
        <p class="text-neutral-600 mb-8">A look back at what the Drama Club has staged.</p>
        {past.length === 0 ? (
          <p class="text-neutral-600">No past productions have been added yet.</p>
        ) : (
          <div class="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {past.map((show) => (
              <ShowCard show={toCard(show)} dates={false} />
            ))}
          </div>
        )}
      </section>
    </div>,
    {
      title: 'Shows',
      description: 'Upcoming and past productions staged by the Fairport Drama Club.',
    },
  );
});
```

The two sections above are `h2`, and `ShowCard`'s title is an `h3`, so the page needs an `h1` above both or the heading order starts at 2:

```tsx
      <h1 class="font-display text-4xl font-bold text-neutral-900">Shows</h1>
```

Imports for this file: add `ShowCard` from `~/components/ShowCard`, `getPromotedShows` and `getShow` from `~/db/queries` (dropping `getCurrentShow`), `showDateLine` from `~/lib/dates` (dropping `formatShowDates`), `can` from `~/lib/auth/permissions`, and `SHOW_COMPANY_LABEL` from `~/services/shows` — not from the schema; the label lives with the service that owns it.

- [ ] **Step 4: Gate drafts and update both isCurrent sites on the show page**

In the `/shows/:slug` handler:

```tsx
  const show = await getShow(db, c.req.param('slug'));
  if (!show) return c.notFound();
  // A draft is hidden from visitors, not from the board member building it.
  // Nothing in the admin links to a show's public page, so 404ing everyone
  // would leave no way to check a page before announcing it - and announcing
  // is the only other way to see it, which publishes it to the home page.
  if (show.isDraft && !can(c.get('role') ?? null, 'show', 'update')) {
    return c.notFound();
  }
```

`can` takes `AppRole | null` and returns false for null, so a signed-out visitor is refused without a special case. `c.get('role')` really is available here: `actorMiddleware` is registered `app.use('*', ...)` at `index.tsx:23` and sets `role` on every request, `null` when there is no session — it is not admin-only middleware. Verified; if it were admin-only this gate would 404 the very people it exists for.

Then replace **both** occurrences of `show.isCurrent && !closed` — the gradient at what was line 108, and the Get Tickets button at what was line 162 — with `show.isAnnounced && !closed`.

The ticket button is a deliberate behavior change: every announced running show now offers its own ticket link, where previously only the single featured show did. That is the point of concurrent productions.

**Change the show page's date line too.** `shows.tsx:138` has the same `formatShowDates(performances)` problem — an announced show with no dates renders a blank `<dd>`. `show` comes from `getShow`, which now projects the endpoints, so use `showDateLine(show.firstPerformance, show.lastPerformance)` and change the import at `:18` from `formatShowDates` to `showDateLine`. `hasClosed` stays.

Add the company badge beside the season in the hero:

```tsx
{show.company && (
  <span class="ml-2 px-2 py-0.5 rounded-full bg-white/20 text-white text-xs font-medium">
    {SHOW_COMPANY_LABEL[show.company]}
  </span>
)}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --config vitest.workers.config.ts src/routes/public-pages.workers-test.ts`
Expected: every test touching `/shows`, `/shows/current`, `/shows/past`, or `/shows/:slug` passes, including all eight new ones. **The file as a whole does not go green here** — seven tests still 500 because `home.tsx` and `system.tsx` import `getCurrentShow` and `formatShowDates`, deleted in tasks 2 and 3. Tasks 7 and 10 fix those. Do not chase them.

- [ ] **Step 6: Commit**

```bash
git add src/routes/shows.tsx src/routes/public-pages.workers-test.ts
git commit -m "feat(shows): add a shows index and 404 drafts

One page holds the season and the archive, so a visitor sees both spring
productions rather than whichever one the nav happened to point at.
/shows/:slug also stops serving shows nobody has announced - harmless
with one staged show, less so with four a year."
```

---

## Task 7: The home page

**Files:**
- Modify: `src/routes/home.tsx`
- Test: `src/routes/home-past-shows.workers-test.ts`

- [ ] **Step 1: Write the failing tests**

First update the file's own helper. `seedShow` at `:24` takes an options object — `(id, { year, current?, highlighted?, lastDate })` — and sets `title: id`. Rename its `current` key to `announced` and the column it writes to `isAnnounced`. Then add a text helper beside it, since the file currently inlines `await (await get('/')).text()` at three call sites:

```ts
const body = async (path: string) => (await get(path)).text();
```

Then add:

```ts
describe('concurrent shows', () => {
  it('heroes the soonest show and bands the rest', async () => {
    await seedShow('varsity-show', { year: 2027, announced: true, lastDate: iso(10) });
    await seedShow('jv-show', { year: 2027, announced: true, lastDate: iso(25) });

    const html = await body('/');

    // Presence before position: indexOf returns -1 for a show that never
    // rendered, and -1 is less than any real index, so the comparisons
    // alone pass for a page missing both shows.
    expect(html).toContain('varsity-show');
    expect(html).toContain('jv-show');
    expect(html).toContain('Also this season');
    expect(html.indexOf('varsity-show')).toBeLessThan(html.indexOf('Also this season'));
    expect(html.indexOf('Also this season')).toBeLessThan(html.indexOf('jv-show'));
  });

  it('hides the band when only one show is upcoming', async () => {
    await seedShow('only-show', { year: 2027, announced: true, lastDate: iso(10) });

    expect(await body('/')).not.toContain('Also this season');
  });

  it('keeps the wrap hero when every announced show has closed', async () => {
    await seedShow('closed-show', { year: 2026, announced: true, lastDate: iso(-30) });

    const html = await body('/');
    expect(html).toContain('a wrap');
    expect(html).not.toContain('Also this season');
  });

  it('says the dates are unset rather than rendering a blank line', async () => {
    await db().insert(shows).values({
      id: 'no-dates-yet',
      title: 'no-dates-yet',
      season: 'Fall 2027',
      year: 2027,
      synopsis: 'Announced before the schedule locked.',
      isAnnounced: true,
    });

    expect(await body('/')).toContain('Dates to be announced');
  });

  it('never lists a promoted show among past productions', async () => {
    await seedShow('upcoming-show', { year: 2027, announced: true, lastDate: iso(10) });
    await seedShow('older-show', { year: 2024, lastDate: iso(-400) });

    const html = await body('/');

    // The section is conditional (home.tsx:281). Absent, indexOf is -1 and
    // slice(-1) is the last character of the page, which contains nothing -
    // so the assertion would pass without the filter working at all.
    const pastIndex = html.indexOf('Past Productions');
    expect(pastIndex).toBeGreaterThan(-1);

    const pastSection = html.slice(pastIndex);
    expect(pastSection).toContain('older-show');
    expect(pastSection).not.toContain('upcoming-show');
  });
});
```

The wrap assertion deliberately matches only `a wrap`. The template source reads `That&rsquo;s a wrap`, but the JSX transform decodes that entity at compile time and Hono escapes only `& < > ' "`, so the response body carries a literal U+2019 rather than `&rsquo;`. Matching the short substring sidesteps the question entirely.

The new module-level `body` shares its name with three existing `const body = await (await get(...)).text()` bindings in this file, at `:52` (inside `listed()`), `:109`, and `:149`. Shadowing is legal, so leave those bindings alone — converting one in place would give you a temporal-dead-zone `ReferenceError` rather than the tidier code it looks like.

- [ ] **Step 1b: Repoint the archive test at the new index**

`:149`, in `describe('the archive is unaffected')`, fetches `/shows/past` and asserts five show ids appear. After task 6 that path returns a 301 with an empty body — `get` uses `redirect: 'manual'` — so all five assertions fail. Change the path to `/shows`. This is the same breakage task 6 step 1b fixes in `public-pages.workers-test.ts`; this file needs it too, and "leave those bindings alone" above refers only to the `const body` shadowing, not to the URL.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --config vitest.workers.config.ts src/routes/home-past-shows.workers-test.ts`
Expected: FAIL.

- [ ] **Step 3: Rework the data load**

Replace the top of the `home.get('/')` handler:

```tsx
  const promoted = await getPromotedShows(db);
  const [hero, ...alsoThisSeason] = promoted;

  // With nothing upcoming the page keeps naming the show that just ran, in
  // its wrap state. Emptying the hero the morning after closing night would
  // be more surprising than marking the run over.
  const featured = hero ?? (await getLastClosedAnnouncedShow(db));
  const closed = !hero && featured !== null;

  const [performances, pastShows, latestNews, sponsors] = await Promise.all([
    featured ? getPerformances(db, featured.id) : Promise.resolve([]),
    getPastShows(db),
    getPublishedNews(db, 3),
    getSponsors(db, { showId: null }),
  ]);

  const promotedIds = new Set([
    ...promoted.map((s) => s.id),
    ...(featured ? [featured.id] : []),
  ]);

  const homePastShows = pastShows
    .filter((s) => !promotedIds.has(s.id))
    .sort(
      (a, b) =>
        Number(b.isHighlighted) - Number(a.isHighlighted) ||
        (b.lastPerformance ?? '').localeCompare(a.lastPerformance ?? ''),
    )
    .slice(0, 3);
```

Then rename every `currentShow` in the hero JSX to `featured`. `state` no longer exists on the row, so every read of it has to go — there are **four**, not three:

- `:56`, `:85`, `:115` — `currentShow.state === 'closed'`, guarding the closing note in the eyebrow, the ticket button, and the wrap panel. These become the local `closed`.
- `:398` — `currentShow?.state === 'running'`, which gates injecting `countdownScript()` at the foot of the page. This one is easy to miss because it sits outside the hero and reads `running` rather than `closed`. It becomes `!closed`. Miss it and the countdown markup renders while its script never loads, so the timer sits at `--` forever. Add the company badge beside `{featured.season}` in the eyebrow, using `SHOW_COMPANY_LABEL` exactly as the show page does.

**Change the hero's date line.** It currently reads `{formatShowDates(performances)}`, which returns an empty string for a show announced before its schedule is locked — leaving a calendar icon beside nothing. `featured` carries the projected endpoints, so use them:

```tsx
<span>{showDateLine(featured.firstPerformance, featured.lastPerformance)}</span>
```

`performances` is still needed for the countdown, so the fetch stays.

The secondary sort above is `lastPerformance`, not `year`, for the same reason `getPastShows` changed: `year` is hand-entered and can disagree with the dates. Sorting the home page's three cards by one key and the archive by another would put the same shows in different orders on two pages.

**Leave the countdown alone.** It looks like it counts down to a date that has passed once a run is underway, but it does not: `countdownScript` targets `date + 'T19:00:00'` — curtain, not midnight — and when that goes negative it zeroes every unit, reveals "The show has opened!", and clears the interval (`src/components/CountdownTimer.tsx:47-68`). So opening morning correctly counts down to that night, and mid-run correctly says the show has opened. Do not add a `hasOpened` guard; it would hide a working countdown for the whole of opening day.

`home.tsx` imports to change: add `getPromotedShows` and `getLastClosedAnnouncedShow` from `~/db/queries` (dropping `getCurrentShow`), `ShowCard` and `toShowCardView` from `~/components/ShowCard`, `showDateLine` from `~/lib/dates` (dropping `formatShowDates`; `formatDate` stays, the wrap panel uses it), and `SHOW_COMPANY_LABEL` from `~/services/shows`.

- [ ] **Step 4: Add the band**

Directly after the hero `</section>` and before the "About This Website" section:

```tsx
      {alsoThisSeason.length > 0 && (
        <section class="py-12 bg-neutral-50 border-b border-neutral-200">
          <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 class="font-display text-2xl font-bold text-neutral-900 mb-6">
              Also this season
            </h2>
            <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {alsoThisSeason.map((show) => (
                <ShowCard show={toShowCardView(show, images)} />
              ))}
            </div>
          </div>
        </section>
      )}
```

- [ ] **Step 5: Fix the two internal links to /shows/past**

`home.tsx:87` ("Browse Past Shows" in the wrap hero) and `home.tsx:289` ("All shows") both become `/shows`, so no in-app link bounces through the 301.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --config vitest.workers.config.ts src/routes/home-past-shows.workers-test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/routes/home.tsx src/routes/home-past-shows.workers-test.ts
git commit -m "feat(home): hero the soonest show and band the rest of the season

Two productions run in overlapping windows this spring, so the page shows
the nearest one and lists the others beneath rather than picking one and
hiding the fact that the other exists."
```

---

## Task 8: Navigation

**Files:**
- Modify: `src/components/Header.tsx`, `src/components/Footer.tsx`, `src/routes/system.tsx`
- Test: `src/routes/public-pages.workers-test.ts`

- [ ] **Step 0: Write the failing test**

Nothing in the suite asserts the nav's contents, so this task changes the navigation on every page of the site with no runtime coverage. The grep in step 4 is a static check for missed links; it does not prove the nav still renders. Add to the `remaining public pages` describe:

```ts
  it('points the nav and footer at the index, not the retired URLs', async () => {
    // Any page: both live in BaseLayout.
    const html = await body('/members');

    expect(html).toContain('href="/shows"');
    expect(html).not.toContain('href="/shows/current"');
    expect(html).not.toContain('href="/shows/past"');
  });
```

`/members` rather than `/` deliberately — it renders independently of anything this plan changes, so a failure here means the nav, not the home page.

- [ ] **Step 1: Collapse the header dropdown**

`src/components/Header.tsx:11-16` is a parent named "Shows" with `Current Show` and `Past Shows` children. Replace the whole entry with a plain link:

```ts
  { name: 'Shows', href: '/shows' },
```

`NavItem` already has `href` optional and `children` optional, and `{ name: 'Home', href: '/' }` shows a plain entry is valid, so no type change is needed.

With one index page there is nothing for a dropdown to hold, and a "Past Shows" child aimed at a 301 would be worse than none. `isActive` is `href === '/' ? path === '/' : path.startsWith(href)` (`Header.tsx:35-36`), so a bare `/shows` link highlights on `/shows/:slug` as the dropdown parent used to.

- [ ] **Step 2: Collapse the footer links**

`src/components/Footer.tsx:21-22` carries both. Replace the two entries with one:

```ts
  { name: 'Shows', href: '/shows' },
```

- [ ] **Step 3: Fix the 404 page link**

`src/routes/system.tsx:500` — "Browse Shows" points at `/shows/past`; change it to `/shows`.

- [ ] **Step 4: Verify no in-app link points at the old URLs**

Run: `grep -rn "/shows/past\|/shows/current" src/ --include="*.tsx" | grep -v workers-test`
Expected: four hits, none of them a link you missed — the two redirect handlers at `shows.tsx:34` and `:41`, a comment at `shows.tsx:39` explaining the 301, and `system.tsx:30`, which is the sitemap's `staticPaths` entry that task 10 replaces. Anything beyond those four is a missed link.

- [ ] **Step 5: Run the test**

Run: `npx vitest run --config vitest.workers.config.ts src/routes/public-pages.workers-test.ts`
Expected: the new nav test passes. By this point task 7 has landed, so the whole file should be green.

- [ ] **Step 6: Commit**

```bash
git add src/components/Header.tsx src/components/Footer.tsx src/routes/system.tsx src/routes/public-pages.workers-test.ts
git commit -m "feat(nav): collapse the shows dropdown to one index link"
```

---

## Task 9: Admin

**Files:**
- Modify: `src/routes/admin.tsx`
- Test: `src/routes/admin-shows.workers-test.ts`, `src/routes/admin-pages.workers-test.ts`

- [ ] **Step 1: Update the two admin suites**

Four existing assertions in `src/routes/admin-pages.workers-test.ts` break, not two:

- `:320` `toContain('run over')` — becomes `Closed`.
- `:337` `toContain('Stop featuring it')` — becomes the un-announce button's copy.
- `:353` `toContain('Feature on the home page')` — becomes the announce button's copy.
- `:361` `toContain('not featured on the home page until you say so')` — becomes the new-show form's copy.

And in `src/routes/admin-shows.workers-test.ts`, replace the existing test at `:111` ("features and unfeatures the show"), which posts to `/feature` with a `featured` field and asserts `isCurrent` at `:120` and `:123`. That file uses `post(path, cookie, FormData)` from `~/test/session`; it does not import `app` and uses no `URLSearchParams`. `setup()` signs in as Staff and creates `into-the-woods-2026` by posting `showForm()`, and `showForm(overrides)` builds the form body with per-key overrides — use it rather than assembling `FormData` by hand.

```ts
  const announce = (v: string) => {
    const f = new FormData();
    f.set('announced', v);
    return f;
  };

  it('announces and un-announces the show', async () => {
    const cookie = await setup();

    await post('/admin/shows/into-the-woods-2026/announce', cookie, announce('1'));
    expect((await all())[0]!.isAnnounced).toBe(true);

    await post('/admin/shows/into-the-woods-2026/announce', cookie, announce('0'));
    expect((await all())[0]!.isAnnounced).toBe(false);
  });

  it('announces a show without disturbing another already announced', async () => {
    const cookie = await setup();
    await db().insert(shows).values({
      id: 'matilda-2027',
      title: 'Matilda',
      season: 'Spring 2027',
      year: 2027,
      synopsis: 'A second production.',
    });

    await post('/admin/shows/into-the-woods-2026/announce', cookie, announce('1'));
    await post('/admin/shows/matilda-2027/announce', cookie, announce('1'));

    const announced = (await all()).filter((s) => s.isAnnounced);
    expect(announced.map((s) => s.id).sort()).toEqual([
      'into-the-woods-2026',
      'matilda-2027',
    ]);
  });

  it('stores the company chosen on the form', async () => {
    const cookie = await setup();
    await post(
      '/admin/shows/new',
      cookie,
      showForm({ title: 'Company Test', year: '2027', company: 'jv' }),
    );

    const [row] = await db().select().from(shows).where(eq(shows.id, 'company-test-2027'));
    expect(row!.company).toBe('jv');
  });

  it('rejects a company the form could not have offered', async () => {
    const cookie = await setup();
    await post(
      '/admin/shows/new',
      cookie,
      showForm({ title: 'Forged', year: '2027', company: 'not-a-company' }),
    );

    // isShowCompany guards the boundary. A bare cast would store this, and
    // the badge would then render as an empty pill - `show.company &&` passes
    // on any truthy string while the label lookup returns undefined.
    const [row] = await db().select().from(shows).where(eq(shows.id, 'forged-2027'));
    expect(row!.company).toBeNull();
  });
```

The second test is the admin-facing half of the regression this whole change exists to prevent.

Two more references to the old path live in the permission tests further down the file and break on the rename:

- `:136` `expect(body).not.toContain('/feature')` — becomes `'/announce'`. Left alone it still passes, but vacuously, and stops guarding anything.
- `:147` posts to `/admin/shows/into-the-woods-2026/feature` expecting a 403. After the rename that path 404s and the assertion fails. Point it at `/announce`.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --config vitest.workers.config.ts src/routes/admin-shows.workers-test.ts src/routes/admin-pages.workers-test.ts`
Expected: FAIL — `/announce` 404s.

- [ ] **Step 2b: Rename the admin-pages seed field**

`src/routes/admin-pages.workers-test.ts:69` writes `isCurrent: true` in its own local seed helper. That column is gone, so nothing in that file passes until it is `isAnnounced: true`. Do it here — this file passing is this task's gate, not task 11's.

- [ ] **Step 3: Rename the POST route**

At `src/routes/admin.tsx:4048`, change the path from `/admin/shows/:id/feature` to `/admin/shows/:id/announce`, the form field from `featured` to `announced`, and the call:

```tsx
    await setAnnounced(getDb(c.env.DB), c.get('actor'), showId, wanted);
```

It is an admin-only form target with no external inbound links, so the path changes outright with no redirect.

Imports: `admin.tsx` already pulls from `~/services/shows` at `:70-73`. Swap `setFeaturedShow` for `setAnnounced` there, and add `SHOW_COMPANY_LABEL` and `isShowCompany` to the same import — all three live in that module.

`today` is already computed in the shows-list handler (`:3196-3201`, the same `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })` shape used across the codebase), so `showStatus` has the value it needs without adding another.

- [ ] **Step 4: Rework the shows list**

At `admin.tsx:3188`, swap `isCurrent: shows.isCurrent` for `isAnnounced: shows.isAnnounced` and add `company: shows.company`. Replace the "Home page" column's badge logic (`:3232-3241`) with a derived status:

```tsx
const showStatus = (show: {
  isAnnounced: boolean;
  lastPerformance: string | null;
}, today: string): { label: string; class: string } => {
  const closed = show.lastPerformance !== null && show.lastPerformance < today;
  if (closed) return { label: 'Closed', class: 'bg-neutral-100 text-neutral-700' };
  if (show.isAnnounced) return { label: 'Upcoming', class: 'bg-green-100 text-green-800' };
  return { label: 'Draft', class: 'bg-amber-100 text-amber-800' };
};
```

Rename the column header from "Home page" to "Status" and add a "Company" column rendering `SHOW_COMPANY_LABEL[show.company]` or an em dash.

Draft is worth showing prominently: it now means the show has no public page at all.

- [ ] **Step 5: Rework the announce panel**

At `admin.tsx:3611`, the "Home page" section keys off `show.isCurrent`. Change it to `show.isAnnounced`, point the form at `/admin/shows/${show.id}/announce` with an `announced` field, and replace the copy. The "Featuring this show replaces whichever show is featured now - only one can be" line at `:3629-3630` is now false; replace it with something like "Announcing this show puts it on the home page. Other announced shows stay announced."

- [ ] **Step 6: Add the company select to the form**

In `ShowFormValues` add `company: string`, and in the form markup beside the season field:

```tsx
<select name="company" class="px-2 py-1.5 rounded border border-neutral-300 text-sm">
  <option value="" selected={!values.company}>
    Whole club
  </option>
  {Object.entries(SHOW_COMPANY_LABEL).map(([slug, label]) => (
    <option value={slug} selected={values.company === slug}>
      {label}
    </option>
  ))}
</select>
```

There is one form parser, at `admin.tsx:3387`, shared by create and edit. `ShowFormValues` holds raw strings so the form can be re-rendered with what the user typed after a validation error, so `company` is a `string` there and the coercion happens later:

```ts
// in the values literal at :3387
    company: String(form.get('company') ?? ''),

// at each call site - createShow at :3454, and the details handler
    company: isShowCompany(values.company) ? values.company : null,
```

Assigning `ShowCompany | null` straight into `values.company` does not typecheck. Do not reach for `as ShowCompany` instead: the cast asserts nothing at runtime, so a crafted POST stores any string, and the badge then renders as an empty pill — `{show.company && ...}` passes on a truthy value while `SHOW_COMPANY_LABEL[show.company]` is `undefined`. `readNewsForm` at `admin.tsx:3074` guards its enum exactly this way.

Adding `company: string` to `ShowFormValues` also breaks the two object literals that build one — `admin.tsx:3424` (the new-show defaults) and `:3559` (the edit form's values). Add `company: ''` to the first and `company: show.company ?? ''` to the second.

- [ ] **Step 7: Run the admin tests**

Run: `npx vitest run --config vitest.workers.config.ts src/routes/admin-shows.workers-test.ts src/routes/admin-pages.workers-test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/routes/admin.tsx src/routes/admin-shows.workers-test.ts src/routes/admin-pages.workers-test.ts
git commit -m "feat(admin): announce shows independently and record the company

The list now shows a derived status rather than a featured badge, so a
draft reads as what it is: a show with no public page yet."
```

---

## Task 10: Sitemap

**Files:**
- Modify: `src/routes/system.tsx`
- Test: `src/routes/public-pages.workers-test.ts`

- [ ] **Step 1: Write the failing test**

Add it inside the existing `describe('the sitemap')` at `:480`, which uses `get` — that file never imports `app`. The block seeds no draft, so the test has to seed its own; without that the draft assertion passes vacuously and proves nothing.

```ts
  it('lists the shows index and never a draft show', async () => {
    await db().insert(shows).values({
      id: 'staged-show',
      title: 'Staged Show',
      season: 'Spring 2027',
      year: 2027,
      synopsis: 'Not announced yet.',
      isAnnounced: false,
    });
    await db().insert(showPerformances).values({
      id: 'staged-p',
      showId: 'staged-show',
      date: iso(30),
      time: '7:30 PM',
    });

    const xml = await (await get('/sitemap.xml')).text();
    expect(xml).toContain('<loc>http://localhost:8787/shows</loc>');
    expect(xml).not.toContain('/shows/past');
    expect(xml).not.toContain('staged-show');
  });
```

`SITE_URL` is `http://localhost:8787` in the test environment (`wrangler.jsonc:80`); the production value is only set under `env.production`.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --config vitest.workers.config.ts src/routes/public-pages.workers-test.ts -t sitemap`
Expected: FAIL.

- [ ] **Step 3: Build the sitemap from indexable shows**

In `src/routes/system.tsx`, the `Promise.all` at `:21` destructures four values. It becomes three — `getPastShows` and `getCurrentShow` collapse into one call:

```ts
  const [showIds, memberIds, news] = await Promise.all([
    getIndexableShows(db),
    getIndexableMemberIds(db),
    getPublishedNews(db),
  ]);
```

Change `'/shows/past'` in `staticPaths` to `'/shows'`, and collapse the two show URL spreads into one:

```ts
    ...showIds.map((s) => `/shows/${s.id}`),
```

Update the imports: drop `getPastShows` and `getCurrentShow`, add `getIndexableShows`. This is the file's last dependency on the deleted query, so it should typecheck cleanly afterwards.

- [ ] **Step 4: Run the test**

Run: `npx vitest run --config vitest.workers.config.ts src/routes/public-pages.workers-test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/system.tsx src/routes/public-pages.workers-test.ts
git commit -m "feat(seo): keep drafts out of the sitemap"
```

---

## Task 11: Full verification

- [ ] **Step 1: Typecheck, and expect exactly two errors**

Run: `npm run typecheck`
Expected: **two** errors, both in `src/routes/happy-paths.workers-test.ts` — the `isCurrent` seeds at `:61` and `:152`. Step 2 fixes them; the step order here is deliberate, since that file is the last holder of the old column name.

Anything else is a site the earlier tasks missed. Member-office `isCurrent` errors would mean the rename leaked past `shows` — that field is unrelated and must not be touched.

- [ ] **Step 2: Update happy-paths, which breaks in four places**

`src/routes/happy-paths.workers-test.ts` is not a nav-copy problem; it asserts deleted behavior:

- `:61` and `:152` set `isCurrent` on seeded rows — rename to `isAnnounced`.
- `:78-83` expects `/shows/current` to fall back to `/shows/past` — now `/shows`.
- `:136-144` "marks a featured show whose run is still ahead as simply featured" expects `>featured<` and no `run over` — rewrite for the status column, expecting `Upcoming`.
- `:146-160` "shows a dash for a production that is not featured" expects an em dash for `old-show`, which now renders `Draft` (unannounced, and its 2024 season has no performance rows, so it never closed). Rewrite it to assert `Draft`, or give the row a past performance date and assert `Closed`.

- [ ] **Step 3: Both suites**

Run: `npm test`
Expected: all green.

- [ ] **Step 3b: Rename the last two seed fields**

Both files that seed `isCurrent` in a local helper are renamed by the task whose gate depends on them — `public-pages.workers-test.ts:94` in task 6, `admin-pages.workers-test.ts:69` in task 9. Nothing left to do here; confirm with the grep in the next step.

- [ ] **Step 4: Confirm no stale links or names remain**

```bash
grep -rn "isCurrent\|is_current" src/ scripts/ seed/ | grep -v "endYear\|office"
grep -rn "/shows/past\|/shows/current" src/ --include="*.tsx" | grep -v workers-test
grep -rn "setFeaturedShow\|getCurrentShow\|formatShowDates" src/
```

Expected: the first two return only the redirect handlers in `src/routes/shows.tsx`; the third returns nothing.

- [ ] **Step 5: Exercise it locally against real data**

```bash
npm run db:migrate:local
npm run dev
```

`seed:apply:local` is insert-only and fails with `UNIQUE constraint failed: members.id` against an already-populated database — pre-existing, not caused by this change. Only run it against a fresh database.

Know what the seed actually holds before judging what you see: all four seeded shows have run. The Lightning Thief's performances are 2026-03-05 to -07 (`seed/content.sql:504-506`), and it is the only one with `is_announced` set. So the correct starting state is the wrap hero, not a countdown.

- `/` renders "That's a wrap" for The Lightning Thief, with no band and no countdown. A countdown here would mean the closed rule broke.
- `/shows` shows no Upcoming section at all — it is hidden when nothing is upcoming — and all four productions under Past Productions.
- `/shows/past` redirects to `/shows`; the header has one "Shows" link and no dropdown.
- In the admin, add a show, give it performance dates a few weeks out, and announce it. The home page should now hero it with a countdown.
- Announce a second future show. Confirm **both** stay announced — this is the regression the whole change exists to prevent — that the home page grows an "Also this season" band, and that the soonest of the two heroes.
- Set one of them to JV. The badge must read "JV" on the card, the hero, and the show page. If `jv` appears anywhere on screen, a render site is printing the slug instead of the label.
- Visit a show you created but did not announce. It must 404.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "test: cover concurrent shows end to end"
```

---

## Notes for whoever runs this

**The migration is the only irreversible step.** Verify step 9 of task 1 before moving on — if `is_announced` came out 0 on every row, the rename silently became a drop-and-add and the featured show was lost. On production that is recoverable only by re-announcing by hand.

**The company slugs are provisional.** The club has not decided what to call the two early spring companies. Changing only the display names is a one-line edit to `SHOW_COMPANY_LABEL`. Changing the slugs needs a one-statement `UPDATE` migration. The test in task 1 that asserts no label equals its slug exists to keep that door open.

**Do not add a school-year field.** The archive groups by calendar year, so a fall 2026 show and the spring 2027 shows sit in different groups despite being one season. That is deliberate and argued in the spec's non-goals; "this season" is derived from dates, not from a year column.
