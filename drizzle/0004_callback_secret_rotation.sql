ALTER TABLE `subscriptions` ADD `previous_secret_ref` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `rotation_until` integer DEFAULT 0 NOT NULL;