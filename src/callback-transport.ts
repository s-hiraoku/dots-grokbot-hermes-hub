import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { CallbackPolicyError, type CallbackTransport } from "./events.ts";
export interface PinnedRequest {
  url: URL;
  address: string;
  family: number;
  headers: Record<string, string>;
  body: string;
}
export type Connect = (
  request: PinnedRequest,
) => Promise<{ status: number; body: string }>;
export function publicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
// Connection is pinned to a freshly validated address while TLS verifies the original host.
export const connectHTTPS: Connect = ({
  url,
  address,
  family,
  headers,
  body,
}) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        agent: false,
        family,
        servername: url.hostname,
        headers,
        lookup: (_host, _options, callback) => callback(null, address, family),
      },
      (res) => {
        const status = res.statusCode ?? 503;
        // Permanent statuses need no response body; preserve their classification.
        if (status >= 300 && status < 500 && status !== 429) {
          resolve({ status, body: "" });
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16384) {
            req.destroy(new Error("callback_response_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 503,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    const deadline = setTimeout(
      () => req.destroy(new Error("callback_timeout")),
      10000,
    );
    req.once("close", () => clearTimeout(deadline));
    req.setTimeout(10000, () => req.destroy(new Error("callback_timeout")));
    req.on("error", reject);
    req.end(body);
  });
export class PinnedCallbackTransport implements CallbackTransport {
  private readonly allowed: Set<string>;
  constructor(
    approvedUrls: readonly string[],
    privateOptions: {
      resolve?: (
        hostname: string,
      ) => Promise<{ address: string; family: number }[]>;
      connect?: Connect;
    } = {},
  ) {
    this.allowed = new Set(approvedUrls);
    this.options = privateOptions;
  }
  private readonly options: {
    resolve?: (
      hostname: string,
    ) => Promise<{ address: string; family: number }[]>;
    connect?: Connect;
  };
  async post(raw: string, headers: Record<string, string>, body: string) {
    const url = new URL(raw);
    if (
      !this.allowed.has(url.href) ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== "443")
    )
      throw new CallbackPolicyError("unapproved_callback");
    let addresses: { address: string; family: number }[];
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(hostname))
      addresses = [{ address: hostname, family: isIP(hostname) }];
    else
      addresses = await (
        this.options.resolve ?? ((host) => lookup(host, { all: true }))
      )(hostname);
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
      throw new CallbackPolicyError("nonpublic_callback");
    const result = await (this.options.connect ?? connectHTTPS)({
      url,
      address: addresses[0].address,
      family: addresses[0].family,
      headers,
      body,
    });
    if (result.status >= 300 && result.status < 400)
      throw new CallbackPolicyError("callback_redirect_rejected");
    return result;
  }
}
