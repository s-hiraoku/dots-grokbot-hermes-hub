CREATE TABLE `authorization_audit` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`stopped` integer NOT NULL,
	`epoch` integer NOT NULL,
	`actor` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `authorization_checks` (
	`id` integer PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`client` text,
	`epoch` integer,
	CONSTRAINT "authorization_check_singleton" CHECK("authorization_checks"."id"=1)
);
--> statement-breakpoint
CREATE TABLE `authorization_control_checks` (
	`id` integer PRIMARY KEY NOT NULL,
	`epoch` integer NOT NULL,
	CONSTRAINT "authorization_control_singleton" CHECK("authorization_control_checks"."id"=1)
);
--> statement-breakpoint
CREATE TABLE `authorization_state` (
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`stopped` integer NOT NULL,
	`epoch` integer NOT NULL,
	PRIMARY KEY(`kind`, `target`),
	CONSTRAINT "authorization_kind" CHECK("authorization_state"."kind" IN ('global','subject','client')),
	CONSTRAINT "authorization_target" CHECK(length("authorization_state"."target") BETWEEN 1 AND 200),
	CONSTRAINT "authorization_stopped" CHECK("authorization_state"."stopped" IN (0,1)),
	CONSTRAINT "authorization_epoch" CHECK("authorization_state"."epoch">=0),
	CONSTRAINT "authorization_global" CHECK("authorization_state"."kind"<>'global' OR "authorization_state"."target"='*')
);
--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `client_id` text;
--> statement-breakpoint

-- This gate adds denials only. It does not enable any HTTP authenticator or enroll identities.
INSERT INTO authorization_state VALUES('global','*',0,0);

--> statement-breakpoint

CREATE TRIGGER authorization_check BEFORE INSERT ON authorization_checks BEGIN
  SELECT CASE WHEN
    NOT EXISTS(SELECT 1 FROM authorization_state WHERE kind='global' AND target='*' AND stopped=0 AND (NEW.epoch IS NULL OR epoch=NEW.epoch))
    OR EXISTS(SELECT 1 FROM authorization_state WHERE stopped=1 AND ((kind='subject' AND target=NEW.subject) OR (kind='client' AND (NEW.client IS NULL OR target=NEW.client))))
    THEN RAISE(ABORT,'authorization_rejected') END;
END;

--> statement-breakpoint

CREATE TRIGGER authorization_control_check BEFORE INSERT ON authorization_control_checks BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM authorization_state WHERE kind='global' AND target='*' AND epoch=NEW.epoch)
    THEN RAISE(ABORT,'authorization_changed') END;
END;
