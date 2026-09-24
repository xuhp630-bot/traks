CREATE TABLE `competitor_research_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`root_term` text NOT NULL,
	`root_term_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `competitor_research_group_identity_idx` ON `competitor_research_groups` (`workspace_id`,`root_term_key`,`name_key`);--> statement-breakpoint
ALTER TABLE `competitor_research_profiles` ADD `primary_group_id` text REFERENCES competitor_research_groups(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `competitor_research_workspace_primary_group_idx` ON `competitor_research_profiles` (`workspace_id`,`primary_group_id`);
