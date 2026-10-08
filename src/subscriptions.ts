import { z } from "zod";
import {
  EventSender,
  CallbackPolicyError,
  type CallbackTransport,
} from "./events.ts";
import type { TaskService } from "./store.ts";
import {
  CallbackEndpointError,
  type Principal,
  type Row,
  type Outbox,
  type Statement,
} from "./types.ts";
const statement = (
  sql: string,
  ...params: (string | number | null)[]
): Statement => ({ sql, params });
export const eventArguments = z.object({ task_id: z.string().uuid() }).strict();
const delivery = z
  .object({
    mode: z.literal("webhook"),
    url: z.string().url().max(2048),
    secret: z.string().regex(/^whsec_[A-Za-z0-9+/]{32,88}={0,2}$/),
  })
  .strict();
export const subscribeArguments = z
  .object({
    name: z.literal("task.terminal"),
    arguments: eventArguments,
    delivery,
    cursor: z.null().optional(),
    ttlMs: z.number().int().min(1000).max(86400000).nullable().optional(),
  })
  .strict();
export const unsubscribeArguments = z
  .object({
    name: z.literal("task.terminal"),
    arguments: eventArguments,
    delivery: z
      .object({ mode: z.literal("webhook"), url: z.string().url().max(2048) })
      .strict(),
  })
  .strict();
export interface EventAPI {
  list(p: Principal): Promise<unknown>;
  subscribe(p: Principal, args: unknown): Promise<unknown>;
  unsubscribe(p: Principal, args: unknown): Promise<unknown>;
}
/** Key provisioning is outside this module. Persistent secret ciphertext is bound to owner and revision. */
export class SecretVault {
  readonly key: CryptoKey;
  constructor(key: CryptoKey) {
    if (
      key.algorithm.name !== "AES-GCM" ||
      key.type !== "secret" ||
      !key.usages.includes("encrypt") ||
      !key.usages.includes("decrypt")
    )
      throw Error("invalid_vault_key");
    this.key = key;
  }
  async seal(value: string, aad: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
      this.key,
      new TextEncoder().encode(value),
    );
    return `${Buffer.from(iv).toString("base64")}.${Buffer.from(ciphertext).toString("base64")}`;
  }
  async open(value: string, aad: string) {
    const parts = value.split(".");
    if (parts.length !== 2) throw Error("invalid_ciphertext");
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Buffer.from(parts[0], "base64"),
        additionalData: new TextEncoder().encode(aad),
      },
      this.key,
      Buffer.from(parts[1], "base64"),
    );
    return new TextDecoder().decode(plaintext);
  }
}
const aad = (row: Row) => JSON.stringify([row.id, row.subject, row.revision]);
/** No transport defaults: callers must supply the existing pinned, allowlisted callback transport. */
export class SubscriptionService implements EventAPI {
  readonly hub: TaskService;
  readonly vault: SecretVault;
  readonly transportFor: (url: string) => CallbackTransport;
  readonly identityActive: (subject: string) => Promise<boolean>;
  constructor(options: {
    hub: TaskService;
    vault: SecretVault;
    transportFor: (url: string) => CallbackTransport;
    identityActive: (subject: string) => Promise<boolean>;
  }) {
    this.hub = options.hub;
    this.vault = options.vault;
    this.transportFor = options.transportFor;
    this.identityActive = options.identityActive;
  }
  private async identity(subject: string, task: string) {
    return (
      (await this.identityActive(subject)) &&
      (await this.hub.canNotify(subject, task))
    );
  }
  private async identifier(subject: string, task: string, url: string) {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([subject, "task.terminal", task, url]),
      ),
    );
    return Buffer.from(hash).toString("hex");
  }
  async list(p: Principal) {
    this.hub.principal(p, "events");
    return {
      events: [
        {
          name: "task.terminal",
          description: "A fixed task reached a terminal state.",
          inputSchema: z.toJSONSchema(eventArguments),
          payloadSchema: {
            type: "object",
            properties: {
              task_id: { type: "string", format: "uuid" },
              state: { enum: ["succeeded", "failed", "cancelled"] },
            },
            required: ["task_id", "state"],
            additionalProperties: false,
          },
          delivery: ["webhook"],
        },
      ],
    };
  }
  private async current(id: string) {
    return (
      await this.hub.driver.batch([
        statement("SELECT * FROM subscriptions WHERE id=?", id),
      ])
    )[0][0];
  }
  private async active(row: Row, pending = false) {
    if (!(await this.identity(String(row.subject), String(row.task))))
      return false;
    const clock = this.hub.driver.nowSQL;
    const rows = await this.hub.driver.batch([
      statement(
        `SELECT id FROM subscriptions WHERE id=? AND revision=? AND expires>${clock}${pending ? "" : " AND active=1"}`,
        String(row.id),
        Number(row.revision),
      ),
    ]);
    return Boolean(rows[0][0]);
  }
  async subscribe(p: Principal, args: unknown) {
    this.hub.principal(p, "events");
    const a = subscribeArguments.parse(args);
    const url = new URL(a.delivery.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      Buffer.from(a.delivery.secret.slice(6), "base64").length < 24 ||
      Buffer.from(a.delivery.secret.slice(6), "base64").length > 64
    )
      throw Error("invalid_callback");
    if (!(await this.identity(p.subject, a.arguments.task_id)))
      throw Error("forbidden");
    const transport = this.transportFor(a.delivery.url); // Operator-owned exact URL allowlist, DNS pinning in transport.
    const id = await this.identifier(
        p.subject,
        a.arguments.task_id,
        a.delivery.url,
      ),
      clock = this.hub.driver.nowSQL;
    const previousRow = await this.current(id);
    const previousSecret =
      previousRow?.active === 1 && Number(previousRow.expires) > this.hub.now()
        ? await this.vault.open(
            String(previousRow.secret_ref),
            aad(previousRow),
          )
        : undefined;
    const rows = await this.hub.driver.batch([
      statement(
        `INSERT INTO subscriptions(id,subject,task,url,secret_ref,revision,expires,active,verified_until,at) VALUES(?,?,?,?, '',1,${clock}+?,0,0,${clock}) ON CONFLICT(id) DO UPDATE SET revision=revision+1,secret_ref='',previous_secret_ref=NULL,rotation_until=0,expires=${clock}+?,active=0,verified_until=0,at=${clock} WHERE subscriptions.revision=? RETURNING *`,
        id,
        p.subject,
        a.arguments.task_id,
        a.delivery.url,
        a.ttlMs ?? 3600000,
        a.ttlMs ?? 3600000,
        previousRow ? Number(previousRow.revision) : -1,
      ),
    ]);
    const row = rows[0][0];
    if (!row) throw Error("subscription_changed");
    const secret = await this.vault.seal(a.delivery.secret, aad(row));
    const rotating = previousSecret && previousSecret !== a.delivery.secret;
    const retainedPrevious =
      !rotating &&
      previousRow?.active === 1 &&
      previousRow.previous_secret_ref &&
      Number(previousRow.rotation_until) > this.hub.now()
        ? await this.vault.open(
            String(previousRow.previous_secret_ref),
            aad(previousRow),
          )
        : undefined;
    const previousCiphertext = rotating
      ? await this.vault.seal(previousSecret, aad(row))
      : retainedPrevious
        ? await this.vault.seal(retainedPrevious, aad(row))
        : null;
    const rotationUntil = rotating
      ? Math.min(this.hub.now() + 30000, Number(previousRow.expires))
      : retainedPrevious
        ? Number(previousRow.rotation_until)
        : 0;
    await this.hub.driver.batch([
      statement(
        "UPDATE subscriptions SET secret_ref=?,previous_secret_ref=?,rotation_until=? WHERE id=? AND revision=?",
        secret,
        previousCiphertext,
        rotationUntil,
        id,
        Number(row.revision),
      ),
    ]);
    const sender = new EventSender({
      subscription: {
        id,
        subject: p.subject,
        task_id: a.arguments.task_id,
        url: a.delivery.url,
        secret: a.delivery.secret,
        expiresAt: Number(row.expires),
      },
      transport,
      authorise: () => this.active(row, true),
      now: () => this.hub.now(),
    });
    const cached =
      previousRow?.active === 1 &&
      previousSecret === a.delivery.secret &&
      Number(previousRow.verified_until) > this.hub.now();
    try {
      if (!cached) await sender.verify();
    } catch (error) {
      throw new CallbackEndpointError(
        error instanceof CallbackPolicyError
          ? "endpoint_rejected"
          : "challenge_failed",
      );
    }
    if (!(await this.active(row, true))) throw Error("subscription_changed");
    const result = await this.hub.driver.batch([
      statement(
        `UPDATE subscriptions SET active=1,verified_until=MIN(expires,?) WHERE id=? AND revision=? AND expires>${clock} AND EXISTS(SELECT 1 FROM tasks WHERE id=subscriptions.task AND (owner=subscriptions.subject OR EXISTS(SELECT 1 FROM task_access g WHERE g.task=tasks.id AND g.subject=subscriptions.subject AND g.notify=1))) RETURNING id,expires`,
        cached ? Number(previousRow.verified_until) : this.hub.now() + 300000,
        id,
        Number(row.revision),
      ),
    ]);
    if (!result[0][0]) throw Error("subscription_changed");
    return {
      id,
      refreshBefore: new Date(Number(row.expires)).toISOString(),
      cursor: null,
      truncated: false,
    };
  }
  async unsubscribe(p: Principal, args: unknown) {
    this.hub.principal(p, "events");
    const a = unsubscribeArguments.parse(args);
    const id = await this.identifier(
      p.subject,
      a.arguments.task_id,
      a.delivery.url,
    );
    await this.hub.driver.batch([
      statement(
        "UPDATE subscriptions SET active=0,revision=revision+1 WHERE id=? AND subject=?",
        id,
        p.subject,
      ),
    ]);
    return {};
  }
  /** One durable attempt. Reopen and call again; total attempts remain bounded in the database. */
  async dispatchOne(): Promise<boolean> {
    const clock = this.hub.driver.nowSQL;
    await this.hub.driver.batch([
      statement(
        `INSERT OR IGNORE INTO deliveries(id,subscription,event,state,fence,lease,attempts,retry_at,revision,at) SELECT s.id||':'||o.id,s.id,o.id,'pending',0,NULL,0,0,s.revision,${clock} FROM subscriptions s JOIN outbox o ON o.task=s.task WHERE s.active=1 AND s.expires>${clock}`,
      ),
      statement(
        `UPDATE deliveries SET revision=(SELECT revision FROM subscriptions WHERE id=deliveries.subscription) WHERE state='pending' OR (state='running' AND lease<=${clock})`,
      ),
    ]);
    await this.hub.driver.batch([
      statement(
        `UPDATE deliveries SET state='dead',lease=NULL WHERE attempts>=5 AND (state='pending' OR (state='running' AND lease<=${clock}))`,
      ),
    ]);
    const rows = await this.hub.driver.batch([
      statement(
        `UPDATE deliveries SET state='running',fence=fence+1,lease=${clock}+30000,attempts=attempts+1,at=${clock} WHERE id=(SELECT d.id FROM deliveries d JOIN subscriptions s ON s.id=d.subscription WHERE (d.state='pending' OR (d.state='running' AND d.lease<=${clock})) AND d.retry_at<=${clock} AND d.attempts<5 AND s.active=1 AND s.expires>${clock} ORDER BY d.at,d.id LIMIT 1) RETURNING *`,
      ),
    ]);
    const job = rows[0][0];
    if (!job) return false;
    const row = await this.current(String(job.subscription));
    if (!row) return true;
    const valid = async () => {
      if (
        !(await this.active(row)) ||
        Number(row.revision) !== Number(job.revision)
      )
        return false;
      const current = await this.hub.driver.batch([
        statement(
          `SELECT id FROM deliveries WHERE id=? AND fence=? AND state='running' AND lease>${clock}`,
          String(job.id),
          Number(job.fence),
        ),
      ]);
      return Boolean(current[0][0]);
    };
    let state = "delivered";
    try {
      if (!(await valid()))
        throw new CallbackPolicyError("delivery_not_authorised");
      const secret = await this.vault.open(String(row.secret_ref), aad(row));
      const previousSecret =
        row.previous_secret_ref && Number(row.rotation_until) > this.hub.now()
          ? {
              secret: await this.vault.open(
                String(row.previous_secret_ref),
                aad(row),
              ),
              until: Number(row.rotation_until),
            }
          : undefined;
      const sender = new EventSender({
        previousSecret,
        subscription: {
          id: String(row.id),
          subject: String(row.subject),
          task_id: String(row.task),
          url: String(row.url),
          secret,
          expiresAt: Number(row.expires),
        },
        transport: this.transportFor(String(row.url)),
        authorise: valid,
        allowGrantedRecipient: true,
        maxAttempts: 1,
        now: () => this.hub.now(),
      });
      await sender.verify();
      const events = await this.hub.driver.batch([
        statement("SELECT * FROM outbox WHERE id=?", String(job.event)),
      ]);
      if (!events[0][0]) throw new CallbackPolicyError("event_missing");
      await sender.send(events[0][0] as unknown as Outbox);
      if (!(await valid())) throw new CallbackPolicyError("delivery_changed");
    } catch (error) {
      state =
        error instanceof CallbackPolicyError ||
        (error instanceof Error &&
          error.message === "delivery_terminal_rejection") ||
        Number(job.attempts) >= 5
          ? "dead"
          : "pending";
    }
    await this.hub.driver.batch([
      statement(
        `UPDATE deliveries SET state=?,lease=NULL,retry_at=${clock}+?,at=${clock} WHERE id=? AND fence=? AND state='running' AND lease>${clock} AND revision=? AND EXISTS(SELECT 1 FROM subscriptions current WHERE current.id=deliveries.subscription AND current.revision=deliveries.revision) AND (?<>'delivered' OR EXISTS(SELECT 1 FROM subscriptions s JOIN tasks t ON t.id=s.task WHERE s.id=deliveries.subscription AND s.revision=deliveries.revision AND s.active=1 AND s.expires>${clock} AND (t.owner=s.subject OR EXISTS(SELECT 1 FROM task_access g WHERE g.task=t.id AND g.subject=s.subject AND g.notify=1))))`,
        state,
        Math.min(1000 * 2 ** Number(job.attempts), 60000),
        String(job.id),
        Number(job.fence),
        Number(job.revision),
        state,
      ),
    ]);
    return true;
  }
}
