// The performance check: a vault of 100,000 memories over five years, timed at
// what a person waits for. Run with `npm run perf` (not part of npm test; it
// takes a few minutes and one CPU). SIGIL_PERF_MEMORIES sets another size.
// Each step is checked against its budget in docs/PERFORMANCE.md, and the
// timings are written to perf/last-run.json.

import { beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { encodeBundle, hybridSearch, randomId, runSyncPass, search, sealBundle, vaultSigningKey, type Memory } from "@sigil/core";
import { harness, type Harness } from "../test/helpers";
import * as ops from "../src/vault/ops";
import * as sync from "../src/vault/syncOps";
import { groupByMonth } from "../src/vault/timelineGroups";
import { sealPending, proofFor } from "../src/server/seal";
import { listLog, logEntry, logRead } from "../src/server/store";
import { bundleBody } from "../src/server/bundles";
import { seedVault } from "./seed";
import { gmailWorld, fake, tokenServer } from "../../packages/core/test/fixtures/sync";

const N = Number(process.env.SIGIL_PERF_MEMORIES ?? 100_000);
/** Budgets for 100,000 memories on a laptop, in milliseconds. A phone is held to four times these (docs/PERFORMANCE.md). */
const BUDGET = {
  vaultResponse: 5000,
  unlock: 25000,
  keyword: 250,
  keywordCold: 6000,
  semantic: 1000,
  timeline: 500,
  syncPass: 2000,
  sealHour: 1000,
  proof: 50,
  logPage: 200,
  bundle: 75000,
};
const scale = N / 100_000;

const results: Record<string, number | string> = {};
function time<T>(name: string, fn: () => T): T {
  const t = performance.now();
  const out = fn();
  results[name] = Math.round(performance.now() - t);
  return out;
}
async function timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const out = await fn();
  results[name] = Math.round(performance.now() - t);
  return out;
}
const within = (name: keyof typeof BUDGET) => expect(results[name] as number, `${name} (${results[name]} ms, budget ${Math.round(BUDGET[name] * Math.max(scale, 0.05))} ms)`).toBeLessThanOrEqual(BUDGET[name] * Math.max(scale, 0.05) + 50);

let h: Harness;
let seeded: Awaited<ReturnType<typeof seedVault>>;
let data: ops.VaultData;

beforeAll(async () => {
  h = harness();
  const t = performance.now();
  seeded = await seedVault(h, { memories: N, log: Math.round(200_000 * scale) });
  results.seed = Math.round(performance.now() - t);
}, 60 * 60_000);

describe(`a vault of ${N.toLocaleString("en-US")} memories`, () => {
  it("answers and unlocks", async () => {
    const raw = await timeAsync("vaultResponse", async () => {
      const res = await seeded.b.fetcher("/api/vault");
      const text = await res.text();
      results.vaultBytes = text.length;
      return text;
    });
    expect(raw.length).toBeGreaterThan(0);
    data = await timeAsync("unlock", () => ops.loadVault(seeded.b.api, seeded.vault));
    expect(data.memories.length).toBe(N);
    within("vaultResponse");
    within("unlock");
  });

  it("finds by words, the first time and while typing", () => {
    const items = data.memories.map((m) => ({ ...m, text: m.body }));
    const first = time("keywordCold", () => search(items, "harbour invoice"));
    time("keyword", () => search(items, "harbour invoi"));
    expect(first.length).toBeGreaterThan(0);
    within("keywordCold");
    within("keyword");
  });

  it("finds by meaning over every vector", () => {
    const dim = 384;
    const vectors = new Map<string, Float32Array>();
    let seed = 3;
    const r = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) - 0.5;
    for (const m of data.memories) {
      const v = new Float32Array(dim);
      for (let i = 0; i < dim; i++) v[i] = r();
      vectors.set(m.id, v);
    }
    const q = new Float32Array(dim).map(() => r());
    const items = data.memories.map((m) => ({ ...m, text: m.body }));
    search(items, "garden");
    const hits = time("semantic", () => hybridSearch(items, "garden", { queryVector: q, vectors, minSimilarity: 0.1, limit: 50 }));
    expect(hits.length).toBeGreaterThan(0);
    within("semantic");
  });

  it("lays out the timeline", () => {
    const months = time("timeline", () => groupByMonth(data.memories, "all", "createdAt"));
    expect(months.length).toBeGreaterThan(50);
    within("timeline");
  });

  it("syncs into it", async () => {
    const folder = data.folders[0];
    const g = gmailWorld();
    const tokens = tokenServer();
    const world = fake([
      [/oauth2\.googleapis\.com/, (u, init) => tokens.fetch(u.toString(), init)],
      [/gmail\.googleapis\.com/, (u, init) => g.fetch(u.toString(), init)],
    ]);
    const source = await sync.connectSource(seeded.b.api, seeded.vault, { kind: "gmail", clientId: "cid", folder, origin: "http://localhost:3000", authorize: async (_u, state) => ({ code: "good-code", state }), fetch: world.fetch as never });
    await timeAsync("syncPass", async () => {
      const target = sync.vaultTarget(seeded.b.api, data, folder, () => undefined);
      await runSyncPass(source.state!, { target, fetch: world.fetch as never });
    });
    within("syncPass");
  });

  it("seals an hour and proves an entry", () => {
    const hour = Math.floor(Date.now() / 3_600_000) - 1;
    const at = new Date(hour * 3_600_000 + 60_000);
    for (let i = 0; i < 5000 * Math.max(scale, 0.1); i++) logRead(h.db, { appId: seeded.appIds[i % seeded.appIds.length], userId: seeded.userId }, "read", null, 1, at);
    time("sealCatchUp", () => sealPending(h.db));
    const now = new Date();
    for (let i = 0; i < 5000 * Math.max(scale, 0.1); i++) logRead(h.db, { appId: seeded.appIds[0], userId: seeded.userId }, "read", null, 1, now);
    const sealed = time("sealHour", () => sealPending(h.db, Date.now() + 3_600_000));
    results.sealHourLeaves = sealed.reduce((n, x) => n + x.leaves, 0);
    const page = time("logPage", () => listLog(h.db, seeded.userId, 200));
    const sealedOne = page.find((e) => e.hour < Math.floor(Date.now() / 3_600_000)) ?? page[page.length - 1];
    const entry = logEntry(h.db, seeded.userId, sealedOne.id)!;
    const proof = time("proof", () => proofFor(h.db, entry));
    expect(proof).not.toBeNull();
    within("sealHour");
    within("logPage");
    within("proof");
  });

  it("is exported as one bundle", async () => {
    const signing = await vaultSigningKey(seeded.vault.raw);
    const bytes = await timeAsync("bundle", async () => encodeBundle(sealBundle(bundleBody(h.db, seeded.userId, "http://localhost:3000", "vault"), signing)));
    results.bundleBytes = bytes.length;
    within("bundle");
  });

  it("writes down what it measured", () => {
    results.budgetScale = scale;
    results.memories = N;
    results.node = process.version;
    writeFileSync(path.join(import.meta.dirname, "last-run.json"), `${JSON.stringify(results, null, 2)}\n`);
    console.log(results);
    void randomId;
    void ({} as Memory);
  });
});
