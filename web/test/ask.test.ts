// Ask your whole life: one question across every folder, answered on the
// owner's device. The model is a stand-in that records what it was given;
// nothing calls a real model. The server must learn nothing new: no question,
// no answer, and no request at all unless a protected folder is opened for a
// model or an answer is saved (as an ordinary encrypted memory).

import { beforeEach, describe, expect, it } from "vitest";
import { type ModelCaller, type ModelRequest } from "@sigil/core";
import { dumpDb, harness, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as ask from "../src/vault/askOps";
import { setFolderGuard } from "../src/vault/protectOps";

const QUESTION = "CANARY what did I promise Ada last spring?";
const SECRET = "CANARY-bridges-book-71d2";

let h: Harness;
beforeEach(() => {
  h = harness();
});

function stubModel(answer: (req: ModelRequest) => string) {
  const calls: ModelRequest[] = [];
  const model: ModelCaller = {
    provider: "anthropic",
    model: "claude-opus-5-5",
    async complete(req) {
      calls.push(req);
      return answer(req);
    },
  };
  return { model, calls };
}

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();
const NOW = new Date(2026, 10, 24, 12).getTime();

async function setup() {
  const s = await signedUp(h);
  const people = await ops.addFolder(s.b.api, s.vault, "People");
  const travel = await ops.addFolder(s.b.api, s.vault, "Travel");
  const health = await ops.addFolder(s.b.api, s.vault, "Health");
  await ops.createMemory(s.b.api, people, { title: "Promise to Ada", body: `I promised Ada to return the ${SECRET} in April.`, createdAt: at(2026, 4, 10), editedAt: at(2026, 4, 10) });
  await ops.createMemory(s.b.api, travel, { title: "Coast path with Ada", body: "Walked the coast path with Ada.", createdAt: at(2026, 4, 18), editedAt: at(2026, 4, 18) });
  await ops.createMemory(s.b.api, travel, { title: "Mountain hut", body: "Two nights in the hut with Jonas.", createdAt: at(2025, 8, 9), editedAt: at(2025, 8, 9) });
  await ops.createMemory(s.b.api, health, { title: "Knee after the walk with Ada", body: "Physio said rest for two weeks.", createdAt: at(2026, 5, 6), editedAt: at(2026, 5, 6) });
  await setFolderGuard(s.b.api, health, { protect: "health" });
  const data = await ops.loadVault(s.b.api, s.vault);
  return { ...s, data, people, travel, health: data.folders.find((f) => f.id === health.id)! };
}

describe("asking the vault", () => {
  it("answers from every folder on the device, without a single request, and never from a protected folder without a yes", async () => {
    const { data } = await setup();
    const pool = ask.askPool(data);
    const before = h.sent.length;
    const a = await ask.askVault(data, pool, { question: QUESTION, folderIds: [], range: null, open: new Set() }, { model: null, now: NOW });
    expect(h.sent.length).toBe(before);
    expect(a.kind).toBe("evidence");
    expect(a.period?.label).toBe("spring 2026");
    expect(a.sources.map((s) => s.title)).toEqual(["Promise to Ada", "Coast path with Ada"]);
    expect(a.sources.some((s) => s.folder === "Health")).toBe(false);
  });

  it("writes an answer with the owner's model, each sentence linked, and keeps the question off the server", async () => {
    const { data, b } = await setup();
    const { model, calls } = stubModel(() => "You promised Ada to return her book in April [1]. You love her [9].");
    const a = await ask.askVault(data, ask.askPool(data), { question: QUESTION, folderIds: [], range: null, open: new Set() }, { model, now: NOW, api: b.api });
    expect(a.kind).toBe("answer");
    expect(a.sentences).toEqual([{ text: "You promised Ada to return her book in April.", ids: [a.sources[0].id] }]);
    expect(a.dropped).toBe(1);
    expect(calls[0].system).toContain(SECRET);
    expect(calls[0].system).not.toContain("Physio");
    expect(h.sent.join("\n")).not.toContain("CANARY");
    expect(dumpDb(h.db)).not.toContain("CANARY");
  });

  it("asks before a protected folder is used, and puts the yes on the record when a model reads it", async () => {
    const { data, b, health } = await setup();
    const pool = ask.askPool(data);
    const matches = await ask.protectedMatches(data, pool, { question: "What happened with my knee after the walk with Ada?", folderIds: [], range: null }, { now: NOW });
    expect(matches).toEqual([{ id: health.id, name: "Health", ids: [expect.any(String)] }]);
    await ask.allowProtected(b.api, matches);
    const requests = (await b.api.get<{ requests: { folderId: string; state: string; requester: string }[] }>("access")).requests;
    expect(requests).toEqual([expect.objectContaining({ folderId: health.id, state: "used", requester: "self" })]);
    const { model, calls } = stubModel(() => "Your physio said to rest for two weeks [1].");
    const a = await ask.askVault(data, pool, { question: "What happened with my knee after the walk with Ada?", folderIds: [], range: null, open: new Set([health.id]) }, { model, now: NOW });
    expect(a.sources[0].folder).toBe("Health");
    expect(calls[0].system).toContain("Physio said rest");
    // No protected match, nothing to ask about.
    expect(await ask.protectedMatches(data, pool, { question: "mountain hut", folderIds: [], range: null }, { now: NOW })).toEqual([]);
  });

  it("keeps to the folders and the range chosen", async () => {
    const { data, travel } = await setup();
    const pool = ask.askPool(data);
    const only = await ask.askVault(data, pool, { question: "Ada", folderIds: [travel.id], range: null, open: new Set() }, { model: null, now: NOW });
    expect(only.sources.map((s) => s.title)).toEqual(["Coast path with Ada"]);
    const lastYear = await ask.askVault(data, pool, { question: "hut", folderIds: [], range: ask.rangeFor("last-year", undefined, NOW), open: new Set() }, { model: null, now: NOW });
    expect(lastYear.sources.map((s) => s.title)).toEqual(["Mountain hut"]);
    const none = await ask.askVault(data, pool, { question: "hut", folderIds: [], range: ask.rangeFor("this-year", undefined, NOW), open: new Set() }, { model: null, now: NOW });
    expect(none.kind).toBe("nothing");
    expect(ask.rangeFor("custom", { from: "2026-04-01", to: "2026-04-30" }, NOW)).toEqual({ from: new Date(2026, 3, 1).getTime(), to: new Date(2026, 4, 1).getTime() });
  });

  it("saves an answer as an encrypted memory with its sources, and never uses it as a source again", async () => {
    const { data, b, vault, people } = await setup();
    const { model } = stubModel(() => "You promised Ada to return her book in April [1].");
    const a = await ask.askVault(data, ask.askPool(data), { question: "What did I promise Ada?", folderIds: [], range: null, open: new Set() }, { model, now: NOW });
    const saved = await ask.saveAnswer(b.api, data, people.id, a);
    expect(saved.source).toEqual({ kind: "note", ref: "ask" });
    expect(saved.body).toContain("Promise to Ada (People");
    expect(dumpDb(h.db)).not.toContain("You promised Ada");
    const after = await ops.loadVault(b.api, vault);
    expect(after.memories.some((m) => m.id === saved.id)).toBe(true);
    expect(ask.askPool(after).some((m) => m.id === saved.id)).toBe(false);
  });

  it("keeps an answer that used a protected folder only in a protected folder", async () => {
    const { data, health } = await setup();
    const pool = ask.askPool(data);
    const a = await ask.askVault(data, pool, { question: "knee physio", folderIds: [], range: null, open: new Set([health.id]) }, { model: null, now: NOW });
    expect(ask.saveFolders(data, a).map((f) => f.name)).toEqual(["Health"]);
    const b2 = await ask.askVault(data, pool, { question: "hut", folderIds: [], range: null, open: new Set() }, { model: null, now: NOW });
    expect(ask.saveFolders(data, b2).length).toBe(data.folders.length);
  });

  it("says plainly when the folders it may read hold nothing", async () => {
    const { data, health } = await setup();
    const a = await ask.askVault(data, ask.askPool(data), { question: "knee", folderIds: [health.id], range: null, open: new Set() }, { model: null, now: NOW });
    expect(a.kind).toBe("nothing");
  });
});
