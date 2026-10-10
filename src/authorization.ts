import type { Driver, Principal, Row, Statement } from "./types.ts";

export type StopTarget =
  { kind: "global"; id: "*" } | { kind: "subject" | "client"; id: string };
const sql = (
  query: string,
  ...params: (string | number | null)[]
): Statement => ({
  sql: query,
  params,
});
/** Additional deny boundary, not enrollment or a replacement for JWT validation. */
export class DurableAuthorization {
  readonly driver: Driver;
  constructor(driver: Driver) {
    this.driver = driver;
  }

  async batch(
    p: Principal,
    statements: Statement[],
    peers: readonly { subject: string; clientId: string }[] = [],
  ): Promise<Row[][]> {
    if (
      !p?.subject ||
      p.subject.length > 200 ||
      (p.clientId !== undefined && (!p.clientId || p.clientId.length > 200)) ||
      (p.authorizationEpoch !== undefined &&
        !Number.isSafeInteger(p.authorizationEpoch))
    )
      throw Error("authorization_rejected");
    // Both drivers guarantee an atomic batch. RAISE(ABORT) rolls back the whole batch.
    // The transient check row is inserted and removed under the same write lock.
    const rows = await this.driver.batch([
      sql(
        "INSERT INTO authorization_checks(id,subject,client,epoch) VALUES(1,?,?,?)",
        p.subject,
        p.clientId ?? null,
        p.authorizationEpoch ?? null,
      ),
      ...peers.flatMap((peer) => [
        sql("DELETE FROM authorization_checks WHERE id=1"),
        sql(
          "INSERT INTO authorization_checks(id,subject,client,epoch) VALUES(1,?,?,?)",
          peer.subject,
          peer.clientId,
          p.authorizationEpoch ?? null,
        ),
      ]),
      ...statements,
      sql("DELETE FROM authorization_checks WHERE id=1"),
    ]);
    return rows.slice(1 + peers.length * 2, -1);
  }

  async bind(p: Principal): Promise<Principal> {
    const rows = await this.batch(p, [
      sql(
        "SELECT epoch FROM authorization_state WHERE kind='global' AND target='*'",
      ),
    ]);
    return Object.freeze({
      ...p,
      authorizationEpoch: Number(rows[0][0].epoch),
    });
  }

  async isActive(subject: string, clientId?: string): Promise<boolean> {
    try {
      await this.batch({ subject, clientId, operations: [] }, []);
      return true;
    } catch {
      return false;
    }
  }

  async epoch(): Promise<number> {
    const rows = await this.driver.batch([
      sql(
        "SELECT epoch FROM authorization_state WHERE kind='global' AND target='*'",
      ),
    ]);
    if (!rows[0][0]) throw Error("authorization_unavailable");
    return Number(rows[0][0].epoch);
  }

  /** Trusted local maintenance capability only; never registered as an HTTP/MCP tool.
   * CAS prevents competing operators from silently overwriting a newer decision.
   * Restoring admission neither enrolls identities nor restarts runs/subscriptions.
   */
  async setStopped(
    target: StopTarget,
    stopped: boolean,
    expectedEpoch: number,
    actor: string,
  ): Promise<void> {
    if (
      !target ||
      !["global", "subject", "client"].includes(target.kind) ||
      !target.id ||
      target.id.length > 200 ||
      (target.kind === "global" && target.id !== "*") ||
      typeof stopped !== "boolean" ||
      !Number.isSafeInteger(expectedEpoch) ||
      expectedEpoch < 0 ||
      !actor ||
      actor.length > 200
    )
      throw Error("invalid_stop_change");
    const clock = this.driver.nowSQL;
    await this.driver.batch([
      sql(
        "INSERT INTO authorization_control_checks(id,epoch) VALUES(1,?)",
        expectedEpoch,
      ),
      sql(
        "INSERT INTO authorization_state(kind,target,stopped,epoch) VALUES(?,?,?,0) ON CONFLICT(kind,target) DO UPDATE SET stopped=excluded.stopped",
        target.kind,
        target.id,
        Number(stopped),
      ),
      sql(
        "UPDATE authorization_state SET epoch=epoch+1 WHERE kind='global' AND target='*'",
      ),
      ...(stopped
        ? [
            sql(
              `UPDATE subscriptions SET active=0,revision=revision+1,at=${clock} WHERE ?='global' OR (?='subject' AND subject=?) OR (?='client' AND (client_id=? OR client_id IS NULL))`,
              target.kind,
              target.kind,
              target.id,
              target.kind,
              target.id,
            ),
          ]
        : []),
      sql(
        `INSERT INTO authorization_audit(kind,target,stopped,epoch,actor,at) SELECT ?,?,?,epoch,?,${clock} FROM authorization_state WHERE kind='global' AND target='*'`,
        target.kind,
        target.id,
        Number(stopped),
        actor,
      ),
      sql("DELETE FROM authorization_control_checks WHERE id=1"),
    ]);
  }
}
