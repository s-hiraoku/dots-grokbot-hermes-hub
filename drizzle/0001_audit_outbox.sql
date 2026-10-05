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
