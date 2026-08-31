ALTER TABLE `shows` RENAME COLUMN "is_current" TO "is_announced";--> statement-breakpoint
DROP INDEX `idx_shows_current`;--> statement-breakpoint
ALTER TABLE `shows` ADD `company` text;--> statement-breakpoint
CREATE INDEX `idx_shows_announced` ON `shows` (`is_announced`);