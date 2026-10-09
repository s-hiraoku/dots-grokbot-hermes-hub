CREATE TABLE `__new_tasks` (
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
	`runner_scope` text,
	`runner_subject` text,
	`result` text,
	`actor` text NOT NULL,
	`at` integer NOT NULL,
	`mutation` text NOT NULL,
	CONSTRAINT "valid_state" CHECK("__new_tasks"."state" IN ('queued','running','waiting_approval','succeeded','failed','cancelled')),
	CONSTRAINT "fixed_task_type" CHECK("__new_tasks"."task_type" IN ('connectivity_check','shift_log_inventory')),
	CONSTRAINT "valid_gate" CHECK("__new_tasks"."execution_open" IN (0,1))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "owner", "destination", "request_key", "task_type", "state", "execution_open", "fence", "lease", "run_id", "runner_scope", "runner_subject", "result", "actor", "at", "mutation") SELECT "id", "owner", "destination", "request_key", "task_type", "state", "execution_open", "fence", "lease", "run_id", "runner_scope", "runner_subject", "result", "actor", "at", "mutation" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE UNIQUE INDEX `request_idempotency` ON `tasks` (`owner`,`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `single_execution` ON `tasks` (`destination`) WHERE "tasks"."execution_open"=1;--> statement-breakpoint
CREATE INDEX `queue_order` ON `tasks` (`destination`,`state`,`at`);
--> statement-breakpoint
CREATE TRIGGER tasks_insert_audit AFTER INSERT ON tasks BEGIN
 INSERT INTO audit(task,actor,state,fence,at) VALUES(NEW.id,NEW.actor,NEW.state,NEW.fence,NEW.at);
END;
--> statement-breakpoint
CREATE TRIGGER tasks_update_audit AFTER UPDATE ON tasks
WHEN OLD.mutation<>NEW.mutation BEGIN
 INSERT INTO audit(task,actor,state,fence,at) VALUES(NEW.id,NEW.actor,NEW.state,NEW.fence,NEW.at);
END;
--> statement-breakpoint
CREATE TRIGGER tasks_terminal_outbox AFTER UPDATE ON tasks
WHEN OLD.state<>NEW.state AND NEW.state IN ('succeeded','failed','cancelled') BEGIN
 INSERT OR IGNORE INTO outbox(id,task,owner,event,at) VALUES(NEW.id || ':' || NEW.state,NEW.id,NEW.owner,NEW.state,NEW.at);
END;
