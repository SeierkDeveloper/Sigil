// The engine check: how long the server itself takes to answer what people and
// AI apps ask most often, on a vault kept in a real database file (as on the
// node, not in memory). Only time spent inside the server is counted; the app's
// own decryption is not. Run with `npm run perf:engine`; timings go to
// perf/last-engine.json so a change can be compared with the run before it.

import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/server/db";
import { handleApi } from "../src/server/api";
import { resetRateLimits } from "../src/server/http";
import { createApi, type Fetcher } from "../src/vault/api";
import { ORIGIN, wallet, type Harness } from "../test/helpers";
import { VaultReader } from "../../connector/src/reader";
import * as ops from "../src/vault/ops";
import { drafts, seedVault } from "./seed";

const N = Number(process.env.SIGIL_PERF_MEMORIES ?? 20_000);
const ROUNDS = Number(process.env.SIGIL_PERF_ROUNDS ?? 200);

const spent: Record<string, number[]> = {};
async function timed(name: string, fn: () => Promise<Response>): Promise<Response> {
  const t = performance.now();
  const res = await fn();
  (spent[name] ??= []).push(performance.now() - t);
  return res;
}
const route = (url: URL) => url.pathname.replace(/^\/api\//, "");
const label = (method: string, url: URL) => `${method} ${route(url).replace(/[A-Za-z0-9_-]{16,}/g, ":id")}`;

let dir: string;
let h: Harness;

beforeAll(async () => {
  resetRateLimits();
  dir = mkdtempSync(path.join(tmpdir(), "sigil-engine-"));
  const db = openDb(path.join(dir, "sigil.db"));
  const browser = () => {
    let cookie: string | null = null;
    const fetcher: Fetcher = async (input, init = {}) => {
      const url = new URL(input, ORIGIN);
      const headers = new Headers(init.headers);
      headers.set("origin", ORIGIN);
      if (cookie) headers.set("cookie", `sigil_session=${cookie}`);
      const req = new Request(url, { method: init.method, headers, body: init.body as string | undefined });
      const res = await timed(label(init.method ?? "GET", url), () => handleApi(req, route(url).split("/"), db));
      const m = /sigil_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "");
      if (m) cookie = m[1] ? decodeURIComponent(m[1]) : null;
      return res;
    };
    return { api: createApi(fetcher, ORIGIN), cookie: () => cookie, fetcher };
  };
  h = { db, browser, raw: async () => new Response(null), sent: [] };
  await seedVault(h, { memories: N, folders: 20, apps: 6, log: N * 2 });
  for (const k of Object.keys(spent)) delete spent[k];
}, 30 * 60_000);

describe(`the engine, on a ${N.toLocaleString("en-US")} memory vault in a file`, () => {
  it("serves an owner and an AI app, round after round", async () => {
    const owner = h.browser();
    const w = await wallet();
    const { vault } = await ops.signUpWithWallet(owner.api, w.address, w.signature);
    const data = await ops.loadVault(owner.api, vault);
    const notes = data.folders[0];
    await ops.importDrafts(owner.api, notes, drafts(2000, 2, 9));
    const { appKey } = await ops.connectApp(owner.api, vault, { name: "Claude Desktop", kind: "claude-desktop" }, [notes]);
    const reader = new VaultReader({
      appKey,
      baseUrl: ORIGIN,
      fetcher: async (input, init = {}) => {
        const url = new URL(input);
        return timed(label(init.method ?? "GET", url), () => handleApi(new Request(url, init as RequestInit), route(url).split("/"), h.db));
      },
    });
    for (const k of Object.keys(spent)) delete spent[k];

    resetRateLimits();
    const t0 = performance.now();
    for (let i = 0; i < ROUNDS; i++) {
      resetRateLimits();
      await owner.fetcher("/api/session");
      await owner.fetcher("/api/keyslots");
      await owner.fetcher("/api/usage");
      await owner.fetcher("/api/proposals");
      await reader.listFolders();
      const hits = await reader.search(i % 2 ? "harbour invoice" : "garden seeds", { limit: 8 });
      if (hits.length) await reader.read(hits.slice(0, 4).map((x) => x.id));
    }
    const wall = performance.now() - t0;

    const out: Record<string, unknown> = { memories: N, rounds: ROUNDS, at: new Date().toISOString() };
    let server = 0;
    let calls = 0;
    for (const [name, list] of Object.entries(spent).sort()) {
      const sorted = [...list].sort((a, b) => a - b);
      server += list.reduce((a, b) => a + b, 0);
      calls += list.length;
      out[name] = { calls: list.length, median_ms: +sorted[Math.floor(sorted.length / 2)].toFixed(3), p95_ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(3) };
    }
    out.server_ms_total = Math.round(server);
    out.server_ms_per_call = +(server / calls).toFixed(3);
    out.wall_ms = Math.round(wall);
    writeFileSync(path.join(import.meta.dirname, "last-engine.json"), JSON.stringify(out, null, 2) + "\n");
    console.log(JSON.stringify(out, null, 2));
    rmSync(dir, { recursive: true, force: true });
    expect(calls).toBeGreaterThan(0);
  });
});
