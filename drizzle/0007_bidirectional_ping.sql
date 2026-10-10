CREATE TABLE `diagnostic_audit` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`actor_subject` text NOT NULL,
	`actor_client` text NOT NULL,
	`state` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `diagnostic_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`recipient_side` text NOT NULL,
	`kind` text NOT NULL,
	`delivery` text DEFAULT 'pending' NOT NULL,
	`at` integer NOT NULL,
	CONSTRAINT "diagnostic_delivery" CHECK("diagnostic_outbox"."delivery" IN ('pending','attempted','accepted','failed','uncertain')),
	CONSTRAINT "diagnostic_kind" CHECK("diagnostic_outbox"."kind" IN ('requested','replied','expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnostic_event` ON `diagnostic_outbox` (`request_id`,`kind`);--> statement-breakpoint
CREATE TABLE `diagnostic_pings` (
	`id` text PRIMARY KEY NOT NULL,
	`correlation_id` text NOT NULL,
	`request_key` text NOT NULL,
	`sender_side` text NOT NULL,
	`recipient_side` text NOT NULL,
	`sender_subject` text NOT NULL,
	`sender_client` text NOT NULL,
	`recipient_subject` text NOT NULL,
	`recipient_client` text NOT NULL,
	`state` text NOT NULL,
	`created` integer NOT NULL,
	`expires` integer NOT NULL,
	`authorization_epoch` integer NOT NULL,
	`reply_id` text,
	`replied_at` integer,
	`actor_subject` text NOT NULL,
	`actor_client` text NOT NULL,
	`at` integer NOT NULL,
	CONSTRAINT "diagnostic_sides" CHECK("diagnostic_pings"."sender_side" IN ('dots','grok') AND "diagnostic_pings"."recipient_side" IN ('dots','grok') AND "diagnostic_pings"."sender_side"<>"diagnostic_pings"."recipient_side"),
	CONSTRAINT "diagnostic_state" CHECK("diagnostic_pings"."state" IN ('pending','replied','expired')),
	CONSTRAINT "diagnostic_ttl" CHECK("diagnostic_pings"."expires"-"diagnostic_pings"."created" BETWEEN 1000 AND 300000),
	CONSTRAINT "diagnostic_reply" CHECK(("diagnostic_pings"."state"='replied' AND "diagnostic_pings"."reply_id" IS NOT NULL AND "diagnostic_pings"."replied_at" IS NOT NULL) OR ("diagnostic_pings"."state"<>'replied' AND "diagnostic_pings"."reply_id" IS NULL AND "diagnostic_pings"."replied_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnostic_request_key` ON `diagnostic_pings` (`sender_subject`,`sender_client`,`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `diagnostic_correlation` ON `diagnostic_pings` (`correlation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `diagnostic_reply_id` ON `diagnostic_pings` (`reply_id`);
--> statement-breakpoint
CREATE TRIGGER diagnostic_insert AFTER INSERT ON diagnostic_pings BEGIN
 INSERT INTO diagnostic_audit(request_id,actor_subject,actor_client,state,at) VALUES(NEW.id,NEW.actor_subject,NEW.actor_client,NEW.state,NEW.at);
 INSERT INTO diagnostic_outbox(id,request_id,recipient_side,kind,delivery,at) VALUES(NEW.id||':requested',NEW.id,NEW.recipient_side,'requested','pending',NEW.at);
END;
--> statement-breakpoint
CREATE TRIGGER diagnostic_transition AFTER UPDATE ON diagnostic_pings WHEN OLD.state<>NEW.state BEGIN
 INSERT INTO diagnostic_audit(request_id,actor_subject,actor_client,state,at) VALUES(NEW.id,NEW.actor_subject,NEW.actor_client,NEW.state,NEW.at);
 INSERT OR IGNORE INTO diagnostic_outbox(id,request_id,recipient_side,kind,delivery,at) VALUES(NEW.id||':'||NEW.state,NEW.id,NEW.sender_side,NEW.state,'pending',NEW.at);
END;
