CREATE TABLE `token_budget` (
	`period` text PRIMARY KEY NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`ceiling` integer NOT NULL,
	`used` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`attempt` text,
	CONSTRAINT "token_budget_limit" CHECK("token_budget"."ceiling" BETWEEN 1 AND 1000 AND "token_budget"."used" BETWEEN 0 AND "token_budget"."ceiling"),
	CONSTRAINT "token_budget_period" CHECK("token_budget"."end">"token_budget"."start"),
	CONSTRAINT "token_budget_state" CHECK("token_budget"."state" IN ('open','attempting','parked'))
);
--> statement-breakpoint
CREATE TRIGGER token_budget_no_overlap BEFORE INSERT ON token_budget
WHEN EXISTS(SELECT 1 FROM token_budget WHERE period<>NEW.period AND start<NEW.end AND end>NEW.start)
BEGIN SELECT RAISE(ABORT,'overlapping_billing_period'); END;
