CREATE TABLE `competitor_research_category_links` (
	`profile_id` text NOT NULL,
	`category_id` text NOT NULL,
	PRIMARY KEY(`profile_id`, `category_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `competitor_research_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `competitor_categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `competitor_research_category_profile_idx` ON `competitor_research_category_links` (`category_id`,`profile_id`);--> statement-breakpoint
CREATE TABLE `competitor_research_monitor_links` (
	`profile_id` text NOT NULL,
	`monitor_id` text NOT NULL,
	PRIMARY KEY(`profile_id`, `monitor_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `competitor_research_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`monitor_id`) REFERENCES `competitor_monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `competitor_research_monitor_once_idx` ON `competitor_research_monitor_links` (`monitor_id`);--> statement-breakpoint
CREATE TABLE `competitor_research_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`brand_name` text NOT NULL,
	`homepage_url` text NOT NULL,
	`hostname` text NOT NULL,
	`page_title` text,
	`product_summary` text,
	`lifecycle_status` text DEFAULT 'inbox' NOT NULL,
	`seed_keywords` text DEFAULT '[]' NOT NULL,
	`payment_providers` text DEFAULT '[]' NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`source_thread_url` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `competitor_research_workspace_url_idx` ON `competitor_research_profiles` (`workspace_id`,`homepage_url`);--> statement-breakpoint
CREATE INDEX `competitor_research_workspace_status_idx` ON `competitor_research_profiles` (`workspace_id`,`lifecycle_status`);--> statement-breakpoint
CREATE INDEX `competitor_research_hostname_idx` ON `competitor_research_profiles` (`hostname`);--> statement-breakpoint
CREATE TABLE `competitor_research_site_links` (
	`profile_id` text NOT NULL,
	`site_id` text NOT NULL,
	PRIMARY KEY(`profile_id`, `site_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `competitor_research_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `competitor_research_site_profile_idx` ON `competitor_research_site_links` (`site_id`,`profile_id`);