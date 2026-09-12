CREATE TABLE `event_catalogs` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`event_name` text NOT NULL,
	`category` text NOT NULL,
	`description` text,
	`source_path` text,
	`aliases` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_catalogs_site_event_idx` ON `event_catalogs` (`site_id`,`event_name`);--> statement-breakpoint
CREATE INDEX `event_catalogs_site_id_idx` ON `event_catalogs` (`site_id`);