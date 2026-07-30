-- `newsletter_subscribers` predates this project and holds live production
-- data. These five statements are IF NOT EXISTS so this migration is a no-op
-- against the existing database while still creating the table for local
-- development, which starts empty.
CREATE TABLE IF NOT EXISTS `newsletter_subscribers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`subscribed_at` text DEFAULT (datetime('now')) NOT NULL,
	`confirmed_at` text,
	`confirmation_token` text,
	`unsubscribed_at` text,
	`source` text DEFAULT 'website',
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `newsletter_subscribers_email_unique` ON `newsletter_subscribers` (`email`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_subscribers_email` ON `newsletter_subscribers` (`email`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_subscribers_confirmed` ON `newsletter_subscribers` (`confirmed_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_subscribers_active` ON `newsletter_subscribers` (`unsubscribed_at`);--> statement-breakpoint
CREATE TABLE `member_roles` (
	`member_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`member_id`, `role`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_member_roles_role` ON `member_roles` (`role`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`grade` text NOT NULL,
	`graduation_year` integer,
	`photo_image_id` text,
	`bio` text,
	`instagram` text,
	`visibility` text DEFAULT 'limited' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`is_officer` integer DEFAULT false NOT NULL,
	`officer_title` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_members_active` ON `members` (`is_active`);--> statement-breakpoint
CREATE INDEX `idx_members_visibility` ON `members` (`visibility`);--> statement-breakpoint
CREATE TABLE `news` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`excerpt` text NOT NULL,
	`body_md` text NOT NULL,
	`published_at` text NOT NULL,
	`category` text DEFAULT 'general' NOT NULL,
	`author` text,
	`featured_image_id` text,
	`related_show_id` text,
	`is_draft` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`related_show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_news_published` ON `news` (`is_draft`,`published_at`);--> statement-breakpoint
CREATE TABLE `news_tags` (
	`news_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`news_id`, `tag`),
	FOREIGN KEY (`news_id`) REFERENCES `news`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_news_tags_tag` ON `news_tags` (`tag`);--> statement-breakpoint
CREATE TABLE `show_cast` (
	`id` text PRIMARY KEY NOT NULL,
	`show_id` text NOT NULL,
	`member_id` text,
	`role` text NOT NULL,
	`additional_roles` text DEFAULT '[]' NOT NULL,
	`tier` text DEFAULT 'ensemble' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_cast_show` ON `show_cast` (`show_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_cast_member` ON `show_cast` (`member_id`);--> statement-breakpoint
CREATE TABLE `show_crew` (
	`id` text PRIMARY KEY NOT NULL,
	`show_id` text NOT NULL,
	`member_id` text,
	`role` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_crew_show` ON `show_crew` (`show_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_crew_member` ON `show_crew` (`member_id`);--> statement-breakpoint
CREATE TABLE `show_gallery_images` (
	`id` text PRIMARY KEY NOT NULL,
	`show_id` text NOT NULL,
	`image_id` text NOT NULL,
	`caption` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_gallery_show` ON `show_gallery_images` (`show_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `show_performances` (
	`id` text PRIMARY KEY NOT NULL,
	`show_id` text NOT NULL,
	`date` text NOT NULL,
	`time` text NOT NULL,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_performances_show_date` ON `show_performances` (`show_id`,`date`);--> statement-breakpoint
CREATE TABLE `shows` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`season` text NOT NULL,
	`year` integer NOT NULL,
	`venue` text DEFAULT 'Fairport High School Auditorium' NOT NULL,
	`synopsis` text NOT NULL,
	`ticket_url` text,
	`poster_image_id` text,
	`hero_image_id` text,
	`og_image_id` text,
	`is_current` integer DEFAULT false NOT NULL,
	`is_highlighted` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_shows_year` ON `shows` (`year`);--> statement-breakpoint
CREATE INDEX `idx_shows_current` ON `shows` (`is_current`);--> statement-breakpoint
CREATE TABLE `spirit_wear` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`price_cents` integer NOT NULL,
	`image_id` text,
	`sizes` text DEFAULT '[]' NOT NULL,
	`colors` text DEFAULT '[]' NOT NULL,
	`category` text DEFAULT 'apparel' NOT NULL,
	`is_available` integer DEFAULT true NOT NULL,
	`is_featured` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_spirit_wear_available` ON `spirit_wear` (`is_available`,`is_featured`);--> statement-breakpoint
CREATE TABLE `sponsors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`logo_image_id` text,
	`website` text,
	`tier` text NOT NULL,
	`show_id` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_sponsors_active_tier` ON `sponsors` (`is_active`,`tier`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_user_id` text,
	`actor_label` text,
	`action` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`payload` text,
	`diff` text,
	`related_entities` text DEFAULT '[]' NOT NULL,
	`ip` text,
	`user_agent` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_target` ON `audit_events` (`target_kind`,`target_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_actor` ON `audit_events` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_action` ON `audit_events` (`action`,`created_at`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`member_id` text,
	`token` text NOT NULL,
	`expires_at` text NOT NULL,
	`accepted_at` text,
	`accepted_by_user_id` text,
	`revoked_at` text,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_unique` ON `invites` (`token`);--> statement-breakpoint
CREATE INDEX `idx_invites_email` ON `invites` (`email`);--> statement-breakpoint
CREATE INDEX `idx_invites_open` ON `invites` (`accepted_at`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `pending_edits` (
	`id` text PRIMARY KEY NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`proposed` text NOT NULL,
	`submitted_by_user_id` text NOT NULL,
	`submitted_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewed_by_user_id` text,
	`reviewed_at` text,
	`review_note` text
);
--> statement-breakpoint
CREATE INDEX `idx_pending_status` ON `pending_edits` (`status`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `idx_pending_target` ON `pending_edits` (`target_kind`,`target_id`);