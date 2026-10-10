import type { Principal } from "./types.ts";
import { DurableAuthorization } from "./authorization.ts";
import { randomUUID } from "node:crypto";
/** Account-wide ledger must be shared by every broker instance/consumer. No secrets persisted. */
export class TokenBroker {
  #cache?: { token: string; expires: number; epoch: number };
  #flight?: Promise<string>;
  private gate: DurableAuthorization;
  private principal: Principal;
  private period: { id: string; start: number; end: number; ceiling: number };
  private acquire: (
    signal: AbortSignal,
  ) => Promise<{ access_token: string; expires_in: number }>;
  private notify: (reason: string) => void;
  private now: () => number;
  constructor(
    gate: DurableAuthorization,
    principal: Principal,
    period: { id: string; start: number; end: number; ceiling: number },
    acquire: (
      signal: AbortSignal,
    ) => Promise<{ access_token: string; expires_in: number }>,
    notify: (reason: string) => void = () => {},
    now: () => number = Date.now,
  ) {
    this.gate = gate;
    this.principal = Object.freeze({ ...principal });
    this.acquire = acquire;
    this.notify = notify;
    this.now = now;
    if (
      !/^[A-Za-z0-9_-]{1,80}$/.test(period.id) ||
      !Number.isSafeInteger(period.start) ||
      !Number.isSafeInteger(period.end) ||
      period.end <= period.start ||
      !Number.isInteger(period.ceiling) ||
      period.ceiling < 1 ||
      period.ceiling > 1000 ||
      !principal.clientId
    )
      throw Error("invalid_broker_config");
    this.period = Object.freeze({ ...period });
  }
  async token(): Promise<string> {
    const p = await this.gate.bind(this.principal);
    if (this.now() < this.period.start || this.now() >= this.period.end)
      throw Error("unverified_billing_period");
    if (
      this.#cache &&
      this.#cache.epoch === p.authorizationEpoch &&
      this.now() < this.#cache.expires
    ) {
      const cache = this.#cache;
      const ledger = await this.gate.batch(p, [
        {
          sql: "SELECT state,start,end,ceiling FROM token_budget WHERE period=?",
          params: [this.period.id],
        },
      ]);
      const row = ledger[0][0];
      if (
        !row ||
        !["open", "attempting"].includes(String(row.state)) ||
        row.start !== this.period.start ||
        row.end !== this.period.end ||
        row.ceiling !== this.period.ceiling
      ) {
        this.#cache = undefined;
        this.notify("budget_or_attempt_blocked");
        throw Error("budget_or_attempt_blocked");
      }
      if (this.now() >= cache.expires) {
        this.#cache = undefined;
        return this.token();
      }
      return cache.token;
    }
    if (this.#flight) return this.#flight;
    this.#flight = this.#request(p);
    try {
      return await this.#flight;
    } finally {
      this.#flight = undefined;
    }
  }
  async #request(p: Principal): Promise<string> {
    const attempt = randomUUID();
    const reservedAt = this.now();
    const rows = await this.gate.batch(p, [
      {
        sql: "INSERT OR IGNORE INTO token_budget(period,start,end,ceiling,used,state) VALUES(?,?,?,?,0,?)",
        params: [
          this.period.id,
          this.period.start,
          this.period.end,
          this.period.ceiling,
          "open",
        ],
      },
      {
        sql: `UPDATE token_budget SET used=used+1,state='attempting',attempt=? WHERE period=? AND start=? AND end=? AND ceiling=? AND state='open' AND used<ceiling`,
        params: [
          attempt,
          this.period.id,
          this.period.start,
          this.period.end,
          this.period.ceiling,
        ],
      },
      {
        sql: `SELECT attempt,state,${this.gate.driver.nowSQL} AS db_now FROM token_budget WHERE period=?`,
        params: [this.period.id],
      },
    ]);
    if (rows[2][0]?.attempt !== attempt || rows[2][0]?.state !== "attempting") {
      this.notify("budget_or_attempt_blocked");
      throw Error("budget_or_attempt_blocked");
    }
    const controller = new AbortController();
    const started = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const remaining = this.period.end - this.now();
      if (remaining <= 0 || this.now() < this.period.start)
        throw Error("expired_billing_period");
      const result = await Promise.race([
        this.acquire(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(Error("token_timeout"));
            },
            Math.min(3000, remaining),
          );
        }),
      ]);
      if (
        typeof result.access_token !== "string" ||
        !result.access_token ||
        result.access_token.length > 16384 ||
        !Number.isInteger(result.expires_in) ||
        result.expires_in <= 30 ||
        result.expires_in > 3600
      )
        throw Error("invalid_token_response");
      if (
        this.now() >=
        Math.min(this.period.end, started + (result.expires_in - 30) * 1000)
      )
        throw Error("expired_token_response");
      const done = await this.gate.batch(p, [
        {
          sql: `UPDATE token_budget SET state='open' WHERE period=? AND attempt=? AND state='attempting' AND ${this.gate.driver.nowSQL}<MIN(?,?) RETURNING period`,
          params: [
            this.period.id,
            attempt,
            Number(rows[2][0].db_now) + (result.expires_in - 30) * 1000,
            Number(rows[2][0].db_now) + this.period.end - reservedAt,
          ],
        },
      ]);
      if (!done[0].length) throw Error("attempt_fenced");
      if (
        this.now() >=
        Math.min(this.period.end, started + (result.expires_in - 30) * 1000)
      )
        throw Error("expired_acknowledgement");
      this.#cache = {
        token: result.access_token,
        expires: Math.min(
          this.period.end,
          started + (result.expires_in - 30) * 1000,
        ),
        epoch: p.authorizationEpoch!,
      };
      return result.access_token;
    } catch {
      // Attempt remains permanently parked: failure/timeout/crash cannot trigger automatic retry.
      this.#cache = undefined;
      // Deny-only parking may run even after an authorization stop; never reopens a budget.
      await this.gate.driver.batch([
        {
          sql: "UPDATE token_budget SET state='parked' WHERE period=?",
          params: [this.period.id],
        },
      ]);
      this.notify("token_acquisition_stopped");
      throw Error("token_acquisition_stopped");
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
}
