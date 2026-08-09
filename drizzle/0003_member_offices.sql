-- Club offices become their own table, so a term survives the person leaving it.
--
-- `is_officer` and `officer_title` described only the present. Dropping them
-- without moving the data first would erase every office on the roster, so the
-- backfill runs between the CREATE and the DROPs. Drizzle generates the schema
-- change but not the data step; that part is written by hand.

CREATE TABLE `member_offices` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`title` text NOT NULL,
	`start_year` integer NOT NULL,
	`end_year` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_offices_member` ON `member_offices` (`member_id`,`start_year`);--> statement-breakpoint
CREATE INDEX `idx_offices_current` ON `member_offices` (`end_year`);--> statement-breakpoint

-- The offices carried over from the Astro content covered the 2025-2026
-- season, which has ended, so these become completed terms. Ids are derived
-- from the member id, so the migration is deterministic and re-running
-- produces the same rows rather than duplicates.
--
-- Charlotte Carr is excluded here: she was not an officer in that content.
-- She was marked one recently, in the admin, as the incoming Co-President -
-- so backfilling her from the flag would invent a 2025-2026 term she never
-- served. Her real term is the one below.
INSERT INTO `member_offices` (`id`, `member_id`, `title`, `start_year`, `end_year`)
SELECT 'office-2025-' || `id`, `id`, `officer_title`, 2025, 2026
FROM `members`
WHERE `is_officer` = 1 AND `officer_title` IS NOT NULL AND `id` <> 'charlotte-carr';
--> statement-breakpoint

-- Charlotte Carr is Co-President for 2026-2027. Named explicitly because it is
-- a fact about this club on this date, not a rule; every other office for the
-- new year is added through the admin.
INSERT INTO `member_offices` (`id`, `member_id`, `title`, `start_year`, `end_year`)
SELECT 'office-2026-' || `id`, `id`, 'Co-President', 2026, NULL
FROM `members`
WHERE `id` = 'charlotte-carr';
--> statement-breakpoint

ALTER TABLE `members` DROP COLUMN `is_officer`;--> statement-breakpoint
ALTER TABLE `members` DROP COLUMN `officer_title`;
