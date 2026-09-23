CREATE TABLE `competitor_monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
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
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `competitor_site_url_idx` ON `competitor_monitors` (`site_id`,`url`);--> statement-breakpoint
CREATE INDEX `competitor_due_idx` ON `competitor_monitors` (`next_check_at`);--> statement-breakpoint
CREATE INDEX `competitor_host_check_idx` ON `competitor_monitors` (`hostname`,`last_checked_at`);--> statement-breakpoint
CREATE TABLE `competitor_snapshots` (
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
	FOREIGN KEY (`monitor_id`) REFERENCES `competitor_monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `competitor_snapshot_monitor_time_idx` ON `competitor_snapshots` (`monitor_id`,`checked_at`);