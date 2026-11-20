import { openDb, type Db } from "../src/server/db";
import { handleApi } from "../src/server/api";
import { createApi, type Api, type Fetcher } from "../src/vault/api";
import { resetRateLimits } from "../src/server/http";

export const ORIGIN = "http://localhost:3000";

export interface Harness {
  db: Db;
  /** A browser: keeps its own cookie, records every body it sends. */
  browser(): Browser;
  /** Raw request into the router. */
  raw(method: string, path: string, init?: { body?: unknown; headers?: Record<string, string> }): Promise<Response>;
  sent: string[];
}

export interface Browser {
  api: Api;
  cookie(): string | null;
  /** The browser's own fetch, for pages that call the site without the Api (the restore page). */
  fetcher: Fetcher;
}

/** A node of its own: a private database, reached at the origin given (no server listens there; requests go straight into the router). */
export function harness(origin = ORIGIN): Harness {
  resetRateLimits();
  const db = openDb(":memory:");
  const sent: string[] = [];

  const raw: Harness["raw"] = async (method, path, init = {}) => {
    const body = init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    if (body) sent.push(body);
    const req = new Request(`${origin}/api/${path}`, { method, body, headers: init.headers });
    return handleApi(req, path.split("?")[0].split("/"), db);
  };

  const browser = (): Browser => {
    let cookie: string | null = null;
    const fetcher: Fetcher = async (input, init = {}) => {
      const url = new URL(input, origin);
      const headers = new Headers(init.headers);
      headers.set("origin", origin);
      if (cookie) headers.set("cookie", `sigil_session=${cookie}`);
      if (typeof init.body === "string") sent.push(init.body);
      const req = new Request(url, { method: init.method, headers, body: init.body as string | undefined });
      const res = await handleApi(req, url.pathname.replace(/^\/api\//, "").split("/"), db);
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        const m = /sigil_session=([^;]*)/.exec(setCookie);
        cookie = m && m[1] ? decodeURIComponent(m[1]) : null;
      }
      return res;
    };
    return { api: createApi(fetcher, origin), cookie: () => cookie, fetcher };
  };

  return { db, browser, raw, sent };
}

/** Every text value stored in the database, for checking that no plaintext was written. */
export function dumpDb(db: Db): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
  return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).join("\n");
}

export function count(db: Db, sql: string, ...params: (string | number)[]): number {
  return Number((db.prepare(sql).get(...params) as { n: number }).n);
}

// ---------------------------------------------------------------- shared vault helpers

import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { walletKeyMessage } from "@sigil/core";
import * as ops from "../src/vault/ops";
import { VaultReader, type ReaderOptions } from "../../connector/src/reader";

export async function wallet() {
  const account = privateKeyToAccount(generatePrivateKey());
  const signature = await account.signMessage({ message: walletKeyMessage(account.address) });
  return { address: account.address, signature };
}

/** A connector on "this machine": its requests go straight into the router, and every body it sends is recorded. */
export function readerFor(h: Harness, appKey: string, opts: Partial<ReaderOptions> = {}, origin = ORIGIN) {
  return new VaultReader({
    appKey,
    baseUrl: origin,
    ...opts,
    fetcher: async (input, init = {}) => {
      const url = new URL(input);
      if (typeof init.body === "string") h.sent.push(init.body);
      return handleApi(new Request(url, init as RequestInit), url.pathname.replace(/^\/api\//, "").split("/"), h.db);
    },
  });
}

export async function signedUp(h: Harness) {
  const b = h.browser();
  const w = await wallet();
  const { vault, phrase } = await ops.signUpWithWallet(b.api, w.address, w.signature);
  const data = await ops.loadVault(b.api, vault);
  return { b, w, vault, phrase, data };
}
