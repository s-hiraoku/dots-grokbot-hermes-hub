CREATE TABLE `audit` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task` text NOT NULL,
	`actor` text NOT NULL,
	`state` text NOT NULL,
	`fence` integer NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`task` text NOT NULL,
	`owner` text NOT NULL,
	`event` text NOT NULL,
	`at` integer NOT NULL,
	`delivered` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`destination` text NOT NULL,
	`request_key` text NOT NULL,
	`task_type` text DEFAULT 'connectivity_check' NOT NULL,
	`state` text NOT NULL,
	`execution_open` integer DEFAULT 0 NOT NULL,
	`fence` integer DEFAULT 0 NOT NULL,
	`lease` integer,
	`run_id` text,
	`result` text,
	`actor` text NOT NULL,
	`at` integer NOT NULL,
	`mutation` text NOT NULL,
	CONSTRAINT "valid_state" CHECK("tasks"."state" IN ('queued','running','waiting_approval','succeeded','failed','cancelled')),
	CONSTRAINT "fixed_task_type" CHECK("tasks"."task_type"='connectivity_check'),
	CONSTRAINT "valid_gate" CHECK("tasks"."execution_open" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `request_idempotency` ON `tasks` (`owner`,`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `single_execution` ON `tasks` (`destination`) WHERE "tasks"."execution_open"=1;--> statement-breakpoint
CREATE INDEX `queue_order` ON `tasks` (`destination`,`state`,`at`);