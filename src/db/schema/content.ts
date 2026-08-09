import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

const timestamps = {
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
};

/**
 * Public visibility for a member.
 *
 * `limited` is the default, including for every member migrated from the
 * Astro site. Opting in to exposure is a deliberate act.
 *
 * `limited` suppresses the photo, bio, and surname, AND removes the detail
 * page entirely: `/members/<slug>` embeds the full name in the URL, canonical
 * tag, and sitemap, so hiding it in the page body alone would not hide it.
 */
export const MEMBER_VISIBILITY = { Full: 'full', Limited: 'limited' } as const;
export type MemberVisibility =
  (typeof MEMBER_VISIBILITY)[keyof typeof MEMBER_VISIBILITY];

export const members = sqliteTable(
  'members',
  {
    // The directory slug from src/content/members/<slug>/, preserved so
    // existing /members/<slug> URLs and every memberId reference migrate 1:1.
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    grade: text('grade').notNull(),
    graduationYear: integer('graduation_year'),
    photoImageId: text('photo_image_id'),
    bio: text('bio'),
    instagram: text('instagram'),
    visibility: text('visibility')
      .$type<MemberVisibility>()
      .notNull()
      .default(MEMBER_VISIBILITY.Limited),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index('idx_members_active').on(t.isActive),
    index('idx_members_visibility').on(t.visibility),
  ],
);

/**
 * Club offices a member has held.
 *
 * Replaces the `is_officer` flag and `officer_title` column, which described
 * only the present: when a term ended, the office was erased along with any
 * record it happened. Six of the seven officers on the roster at the time were
 * Seniors, so a board turnover would have taken the whole history with it.
 *
 * A term is a school year. `endYear` is null while the office is held, which
 * is what makes someone a current officer - there is no separate flag to
 * disagree with this table.
 */
export const memberOffices = sqliteTable(
  'member_offices',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** School year the term began: 2025 means the 2025-2026 year. */
    startYear: integer('start_year').notNull(),
    /** Null while they still hold it. */
    endYear: integer('end_year'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    index('idx_offices_member').on(t.memberId, t.startYear),
    // Finding the sitting board is the commonest read on the members page.
    index('idx_offices_current').on(t.endYear),
  ],
);

export const memberRoles = sqliteTable(
  'member_roles',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.memberId, t.role] }),
    index('idx_member_roles_role').on(t.role),
  ],
);

export const shows = sqliteTable(
  'shows',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    season: text('season').notNull(),
    year: integer('year').notNull(),
    venue: text('venue').notNull().default('Fairport High School Auditorium'),
    synopsis: text('synopsis').notNull(),
    ticketUrl: text('ticket_url'),
    posterImageId: text('poster_image_id'),
    heroImageId: text('hero_image_id'),
    ogImageId: text('og_image_id'),
    isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(false),
    isHighlighted: integer('is_highlighted', { mode: 'boolean' })
      .notNull()
      .default(false),
    ...timestamps,
  },
  (t) => [index('idx_shows_year').on(t.year), index('idx_shows_current').on(t.isCurrent)],
);

export const showPerformances = sqliteTable(
  'show_performances',
  {
    id: text('id').primaryKey(),
    showId: text('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    date: text('date').notNull(), // ISO date, YYYY-MM-DD
    time: text('time').notNull(), // display string, e.g. "7:30 PM"
  },
  (t) => [index('idx_performances_show_date').on(t.showId, t.date)],
);

export const showGalleryImages = sqliteTable(
  'show_gallery_images',
  {
    id: text('id').primaryKey(),
    showId: text('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    imageId: text('image_id').notNull(),
    caption: text('caption'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('idx_gallery_show').on(t.showId, t.sortOrder)],
);

export const SHOW_CAST_TIER = {
  Lead: 'lead',
  Supporting: 'supporting',
  Ensemble: 'ensemble',
} as const;
export type ShowCastTier = (typeof SHOW_CAST_TIER)[keyof typeof SHOW_CAST_TIER];

export const showCast = sqliteTable(
  'show_cast',
  {
    id: text('id').primaryKey(),
    showId: text('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    // NULL means the role is not yet cast (rendered as "TBA"). A non-null
    // value is a real foreign key, so a wrong id is impossible rather than
    // caught by a build-time linter.
    memberId: text('member_id').references(() => members.id, { onDelete: 'restrict' }),
    role: text('role').notNull(),
    additionalRoles: text('additional_roles', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    tier: text('tier').$type<ShowCastTier>().notNull().default(SHOW_CAST_TIER.Ensemble),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    index('idx_cast_show').on(t.showId, t.sortOrder),
    index('idx_cast_member').on(t.memberId),
  ],
);

export const showCrew = sqliteTable(
  'show_crew',
  {
    id: text('id').primaryKey(),
    showId: text('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    memberId: text('member_id').references(() => members.id, { onDelete: 'restrict' }),
    role: text('role').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    index('idx_crew_show').on(t.showId, t.sortOrder),
    index('idx_crew_member').on(t.memberId),
  ],
);

export const NEWS_CATEGORY = {
  Auditions: 'auditions',
  ShowUpdates: 'show_updates',
  Achievements: 'achievements',
  Events: 'events',
  General: 'general',
} as const;
export type NewsCategory = (typeof NEWS_CATEGORY)[keyof typeof NEWS_CATEGORY];

export const news = sqliteTable(
  'news',
  {
    id: text('id').primaryKey(), // slug
    title: text('title').notNull(),
    excerpt: text('excerpt').notNull(),
    bodyMd: text('body_md').notNull(),
    publishedAt: text('published_at').notNull(),
    category: text('category').$type<NewsCategory>().notNull().default(NEWS_CATEGORY.General),
    author: text('author'),
    featuredImageId: text('featured_image_id'),
    relatedShowId: text('related_show_id').references(() => shows.id, {
      onDelete: 'set null',
    }),
    isDraft: integer('is_draft', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (t) => [index('idx_news_published').on(t.isDraft, t.publishedAt)],
);


export const SPONSOR_TIER = {
  Platinum: 'platinum',
  Gold: 'gold',
  Silver: 'silver',
  Bronze: 'bronze',
} as const;
export type SponsorTier = (typeof SPONSOR_TIER)[keyof typeof SPONSOR_TIER];

export const sponsors = sqliteTable(
  'sponsors',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    logoImageId: text('logo_image_id'),
    website: text('website'),
    tier: text('tier').$type<SponsorTier>().notNull(),
    showId: text('show_id').references(() => shows.id, { onDelete: 'set null' }),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (t) => [index('idx_sponsors_active_tier').on(t.isActive, t.tier)],
);

export const SPIRIT_WEAR_CATEGORY = {
  Apparel: 'apparel',
  Accessories: 'accessories',
  Other: 'other',
} as const;
export type SpiritWearCategory =
  (typeof SPIRIT_WEAR_CATEGORY)[keyof typeof SPIRIT_WEAR_CATEGORY];

export const spiritWear = sqliteTable(
  'spirit_wear',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    // Stored in cents to avoid floating point money.
    priceCents: integer('price_cents').notNull(),
    imageId: text('image_id'),
    sizes: text('sizes', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    colors: text('colors', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    category: text('category')
      .$type<SpiritWearCategory>()
      .notNull()
      .default(SPIRIT_WEAR_CATEGORY.Apparel),
    isAvailable: integer('is_available', { mode: 'boolean' }).notNull().default(true),
    isFeatured: integer('is_featured', { mode: 'boolean' }).notNull().default(false),
    ...timestamps,
  },
  (t) => [index('idx_spirit_wear_available').on(t.isAvailable, t.isFeatured)],
);
