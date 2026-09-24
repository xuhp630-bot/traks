CREATE TABLE `competitor_pre_research_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`outcome` text NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`references` text DEFAULT '[]' NOT NULL,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `competitor_pre_research_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `competitor_pre_research_action_run_time_idx` ON `competitor_pre_research_actions` (`run_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `competitor_pre_research_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source` text DEFAULT 'keyword_harvester' NOT NULL,
	`source_job_id` text NOT NULL,
	`source_job_url` text NOT NULL,
	`source_version` text NOT NULL,
	`title` text NOT NULL,
	`current_query` text,
	`harvest_status` text DEFAULT 'unknown' NOT NULL,
	`stage` text DEFAULT 'imported' NOT NULL,
	`seed_keywords` text DEFAULT '[]' NOT NULL,
	`summary` text,
	`source_thread_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `competitor_pre_research_workspace_job_idx` ON `competitor_pre_research_runs` (`workspace_id`,`source_job_id`);--> statement-breakpoint
CREATE INDEX `competitor_pre_research_workspace_stage_idx` ON `competitor_pre_research_runs` (`workspace_id`,`stage`,`updated_at`);