CREATE TABLE `competitor_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `competitor_category_name_idx` ON `competitor_categories` (`workspace_id`,`name_key`);--> statement-breakpoint
CREATE TABLE `__new_competitor_monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text,
	`workspace_id` text,
	`category_id` text,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`hostname` text NOT NULL,
	`selector` text NOT NULL,
	`cadence` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	`next_check_at` integer,
	`last_checked_at` integer,
	`last_success_at` integer,
	`last_success_snapshot` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `competitor_categories`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "competitor_owner_check" CHECK(("__new_competitor_monitors"."site_id" IS NOT NULL AND "__new_competitor_monitors"."workspace_id" IS NULL) OR ("__new_competitor_monitors"."site_id" IS NULL AND "__new_competitor_monitors"."workspace_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_competitor_monitors`("id", "site_id", "workspace_id", "category_id", "name", "url", "hostname", "selector", "cadence", "created_at", "next_check_at", "last_checked_at", "last_success_at", "last_success_snapshot", "lease_until") SELECT "id", "site_id", NULL, NULL, "name", "url", "hostname", "selector", "cadence", "created_at", "next_check_at", "last_checked_at", "last_success_at", "last_success_snapshot", "lease_until" FROM `competitor_monitors`;--> statement-breakpoint
CREATE TABLE `__new_competitor_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`checked_at` integer NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`http_status` integer,
	`snapshot` text,
	`previous` text,
	`previous_checked_at` integer,
	`changes` text NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `__new_competitor_monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_competitor_snapshots` SELECT * FROM `competitor_snapshots`;--> statement-breakpoint
DROP TABLE `competitor_snapshots`;--> statement-breakpoint
DROP TABLE `competitor_monitors`;--> statement-breakpoint
ALTER TABLE `__new_competitor_monitors` RENAME TO `competitor_monitors`;--> statement-breakpoint
ALTER TABLE `__new_competitor_snapshots` RENAME TO `competitor_snapshots`;--> statement-breakpoint
CREATE INDEX `competitor_snapshot_monitor_time_idx` ON `competitor_snapshots` (`monitor_id`,`checked_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `competitor_site_url_idx` ON `competitor_monitors` (`site_id`,`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `competitor_workspace_url_idx` ON `competitor_monitors` (`workspace_id`,`url`);--> statement-breakpoint
CREATE INDEX `competitor_category_idx` ON `competitor_monitors` (`category_id`);--> statement-breakpoint
CREATE INDEX `competitor_due_idx` ON `competitor_monitors` (`next_check_at`);--> statement-breakpoint
CREATE INDEX `competitor_host_check_idx` ON `competitor_monitors` (`hostname`,`last_checked_at`);
