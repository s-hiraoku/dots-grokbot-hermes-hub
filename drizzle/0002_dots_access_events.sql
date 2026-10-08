CREATE TABLE `access_audit` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task` text NOT NULL,
	`subject` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription` text NOT NULL,
	`event` text NOT NULL,
	`state` text NOT NULL,
	`fence` integer DEFAULT 0 NOT NULL,
	`lease` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer DEFAULT 0 NOT NULL,
	`revision` integer NOT NULL,
	`at` integer NOT NULL,
	CONSTRAINT "delivery_state" CHECK("deliveries"."state" IN ('pending','running','delivered','dead'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_event` ON `deliveries` (`subscription`,`event`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`task` text NOT NULL,
	`url` text NOT NULL,
	`secret_ref` text NOT NULL,
	`revision` integer NOT NULL,
	`expires` integer NOT NULL,
	`active` integer DEFAULT 0 NOT NULL,
	`verified_until` integer DEFAULT 0 NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_access` (
	`id` text PRIMARY KEY NOT NULL,
	`task` text NOT NULL,
	`subject` text NOT NULL,
	`notify` integer NOT NULL,
	`actor` text NOT NULL,
	`at` integer NOT NULL,
	CONSTRAINT "notify_boolean" CHECK("task_access"."notify" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_reader` ON `task_access` (`task`,`subject`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `runner_scope` text;
--> statement-breakpoint
CREATE TRIGGER task_access_insert_audit AFTER INSERT ON task_access BEGIN
 INSERT INTO access_audit(task,subject,actor,action,at) VALUES(NEW.task,NEW.subject,NEW.actor,'granted',NEW.at);
END;
