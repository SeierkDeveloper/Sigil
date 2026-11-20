// The public AI self: a page anyone can ask, answered only from the public copy
// of the folders the owner made public, relayed end to end like an ask link,
// every question and answer sealed into the owner's log, with a per-visitor
// limit, a wall the owner can hide answers from, and an off switch.

import { beforeEach, describe, expect, it } from "vitest";
import { cleanRules, newAskSession, openAskMessage, randomId, sealAskMessage, type ModelCaller, type ModelRequest, type PublicReply } from "@sigil/core";
import { count, dumpDb, harness, readerFor, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as self from "../src/vault/selfOps";
import * as pub from "../src/vault/publicOps";
import * as guard from "../src/vault/protectOps";
import { SelfAgent } from "../../connector/src/self";

const PRIVATE = "CANARY-private-diary-3f1a";
const HEALTH = "CANARY-public-health-77";
const TALK = "I give talks about memory and privacy.";

let h: Harness;
beforeEach(() => {
  h = harness();
});

function stubModel(answer: (r: ModelRequest) => string = () => "I talk about memory [1].") {
  const calls: ModelRequest[] = [];
  const model: ModelCaller = { provider: "anthropic", model: "claude-opus-5-5", complete: async (r) => (calls.push(r), answer(r)) };
  return { model, calls };
}

async function setup(opts: { showAnswers?: boolean; perVisitorHour?: number } = {}) {
  const s = await signedUp(h);
  const notes = s.data.folders[0];
  const work = await ops.addFolder(s.b.api, s.vault, "Public work");
  let health = await ops.addFolder(s.b.api, s.vault, "Health");
  await ops.createMemory(s.b.api, notes, { title: "Diary", body: PRIVATE });
  await ops.createMemory(s.b.api, work, { title: "Talks", body: `${TALK} Mail sam@example.org.` });
  await ops.createMemory(s.b.api, health, { title: "Results", body: HEALTH });
  health = await guard.setFolderGuard(s.b.api, health, { protect: "health" });
  await guard.setFolderGuard(s.b.api, work, { redact: ["email"] });
  let data = await ops.loadVault(s.b.api, s.vault);
  const view = await pub.savePublic(s.b.api, s.vault, data, {
    handle: "sam",
    name: "Sam's AI self",
    greeting: "Ask me about my talks.",
    rules: cleanRules({ tone: "Short.", denyTopics: ["salary"] }),
    folderIds: [work.id, health.id],
    perVisitorHour: opts.perVisitorHour ?? 5,
    showAnswers: opts.showAnswers ?? true,
    enabled: true,
    appId: null,
  });
  data = await ops.loadVault(s.b.api, s.vault);
  return { ...s, data, view, work, health };
}

function visitor(handle: string, ip = "198.51.100.7") {
  let session: ReturnType<typeof newAskSession> | null = null;
  const page = async () => (await h.raw("GET", `public/at/${handle}`)).json() as Promise<{ id: string; publicKey: string; online: boolean; enabled: boolean; items: { id: string; title: string }[]; wall: { question: string; answer: string }[] }>;
  const ask = async (text: string) => {
    const p = await page();
    session ??= newAskSession(p.id, p.publicKey);
    const id = randomId();
    const ids = { linkId: p.id, sessionId: session.id, messageId: id };
    const res = await h.raw("POST", `public/at/${handle}/questions`, {
      body: { id, sessionId: session.id, askerKey: session.publicKey, sealed: sealAskMessage(session.key, ids, "q", { v: 1, text, history: [] }) },
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
    });
    return { res, id, ids };
  };
  const answer = async (q: { id: string; ids: { linkId: string; sessionId: string; messageId: string } }) => {
    const r = (await (await h.raw("GET", `public/at/${handle}/questions/${q.id}`)).json()) as { status: string; answer?: string };
    return r.answer ? openAskMessage<PublicReply>(session!.key, q.ids, "a", r.answer) : r;
  };
  return { page, ask, answer };
}

describe("the public copy", () => {
  it("holds only the public folders, masked, never a protected or private one; the vault copy stays encrypted", async () => {
    const s = await setup();
    expect(s.view.secret?.folderIds).toEqual([s.work.id]);
    const rows = h.db.prepare("SELECT title, body FROM public_items").all() as { title: string; body: string }[];
    expect(rows).toEqual([{ title: "Talks", body: `${TALK} Mail [email hidden].` }]);
    const db = dumpDb(h.db);
    expect(db).not.toContain(PRIVATE);
    expect(db).not.toContain(HEALTH);
    // The public self's private key and rules are not readable on the server.
    expect(db).not.toContain("salary");
    const page = await visitor("sam").page();
    expect(page).toMatchObject({ enabled: true, online: false, items: [{ title: "Talks" }] });
    expect(JSON.stringify(page)).not.toContain(TALK);
  });

  it("is published again when a public memory changes", async () => {
    const s = await setup();
    expect(await pub.republish(s.b.api, s.data)).toBe(false);
    await ops.createMemory(s.b.api, s.work, { title: "Book", body: "Writing a book." });
    const data = await ops.loadVault(s.b.api, s.vault);
    expect(await pub.republish(s.b.api, data)).toBe(true);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM public_items")).toBe(2);
  });

  it("refuses a taken or reserved handle", async () => {
    await setup();
    const other = await signedUp(h);
    const data = await ops.loadVault(other.b.api, other.vault);
    const input = { handle: "sam", name: "x", greeting: "", rules: cleanRules({}), folderIds: [], perVisitorHour: 5, showAnswers: false, enabled: true, appId: null };
    await expect(pub.savePublic(other.b.api, other.vault, data, input)).rejects.toMatchObject({ status: 409 });
    await expect(pub.savePublic(other.b.api, other.vault, data, { ...input, handle: "admin" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("a visitor asks", () => {
  it("is told plainly when the owner's device is offline, then answered end to end, marked with sources", async () => {
    const s = await setup();
    const v = visitor("sam");
    const offline = await v.ask("What do you talk about?");
    expect(offline.res.status).toBe(503);
    expect((await offline.res.json()).code).toBe("offline");

    const { model, calls } = stubModel();
    expect(await pub.servePublicOnce(s.b.api, s.data, { model })).toBe(0);
    expect((await v.page()).online).toBe(true);
    const q = await v.ask("What do you talk about?");
    expect(q.res.status).toBe(201);
    expect(await pub.servePublicOnce(s.b.api, s.data, { model })).toBe(1);
    expect(calls[0].system).toContain(TALK);
    expect(calls[0].system).toContain("visitor to the owner's public page");
    expect(calls[0].system).not.toContain(PRIVATE);
    expect(calls[0].system).not.toContain("sam@example.org");
    const reply = (await v.answer(q)) as PublicReply;
    expect(reply).toEqual({ v: 1, text: "I talk about memory.", refused: null, sources: [{ id: expect.any(String), title: "Talks" }] });

    // The source is public and can be read on the page.
    const item = (await (await h.raw("GET", `public/at/sam/items/${reply.sources[0].id}`)).json()) as { body: string };
    expect(item.body).toContain(TALK);

    // The owner's log has the question and answer, sealed.
    const log = await ops.loadLog(s.b.api);
    const entry = log.entries.find((e) => e.kind === "public")!;
    expect(entry).toMatchObject({ appId: s.view.id, memoryId: q.id, count: 1 });
    expect(self.openAskNote(s.data.box!, entry)).toMatchObject({ via: "public", question: "What do you talk about?", answer: "I talk about memory." });
    expect(dumpDb(h.db).match(/What do you talk about/g)?.length).toBe(1); // only on the wall the owner allowed
  });

  it("keeps to the rules, the per-visitor limit, the wall and the off switch", async () => {
    const s = await setup({ perVisitorHour: 2 });
    const { model, calls } = stubModel();
    const v = visitor("sam");
    await pub.servePublicOnce(s.b.api, s.data, { model });
    const denied = await v.ask("What is your salary?");
    await pub.servePublicOnce(s.b.api, s.data, { model });
    expect(((await v.answer(denied)) as PublicReply).refused).toBe("denied_topic");
    expect(calls).toHaveLength(0);
    const second = await v.ask("Talks?");
    await pub.servePublicOnce(s.b.api, s.data, { model });
    const third = await v.ask("More?");
    expect(third.res.status).toBe(429);
    expect((await third.res.json()).code).toBe("visitor_limit");
    // Another visitor is not affected.
    await pub.servePublicOnce(s.b.api, s.data, { model });
    expect((await visitor("sam", "198.51.100.8").ask("Talks?")).res.status).toBe(201);

    // The owner hides an answer from the page.
    let data = await ops.loadVault(s.b.api, s.vault);
    expect(data.publicSelf!.wall.length).toBeGreaterThanOrEqual(2);
    const shown = data.publicSelf!.wall.find((w) => w.question === "Talks?")!;
    await pub.hideWallAnswer(s.b.api, shown.id, true);
    expect((await v.page()).wall.map((w) => w.question)).not.toContain("Talks?");
    void second;

    // Off: the page says so and takes no question.
    data = await ops.loadVault(s.b.api, s.vault);
    await pub.savePublic(s.b.api, s.vault, data, { handle: "sam", name: "Sam", greeting: "", rules: data.publicSelf!.secret!.rules, folderIds: [s.work.id], perVisitorHour: 2, showAnswers: true, enabled: false, appId: null });
    expect(await v.page()).toMatchObject({ enabled: false, online: false, items: [], wall: [] });
    expect((await visitor("sam", "198.51.100.9").ask("Hi")).res.status).toBe(410);
    await pub.turnOffPublic(s.b.api);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM public_items")).toBe(0);
    expect((await h.raw("GET", "public/at/sam")).status).toBe(404);
  });

  it("shows nothing on the wall unless the owner turned it on", async () => {
    const s = await setup({ showAnswers: false });
    const { model } = stubModel();
    const v = visitor("sam");
    await pub.servePublicOnce(s.b.api, s.data, { model });
    const q = await v.ask("Talks?");
    await pub.servePublicOnce(s.b.api, s.data, { model });
    expect(((await v.answer(q)) as PublicReply).text).toBe("I talk about memory.");
    expect(count(h.db, "SELECT COUNT(*) AS n FROM public_wall")).toBe(0);
    expect(dumpDb(h.db)).not.toContain("Talks?");
  });
});

describe("a connector answering the public page", () => {
  it("answers from the public copy with the key wrapped for it", async () => {
    const s = await setup();
    await self.saveModel(s.b.api, s.vault, { provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-CANARY-key" });
    const { appKey, appId } = await ops.connectApp(s.b.api, s.vault, { name: "Home machine", kind: "other" }, []);
    let data = await ops.loadVault(s.b.api, s.vault);
    await pub.savePublic(s.b.api, s.vault, data, { handle: "sam", name: "Sam", greeting: "", rules: data.publicSelf!.secret!.rules, folderIds: [s.work.id], perVisitorHour: 5, showAnswers: false, enabled: true, appId });
    data = await ops.loadVault(s.b.api, s.vault);
    expect(dumpDb(h.db)).not.toContain("sk-ant-CANARY-key");

    const bodies: string[] = [];
    const fetch = async (_i: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Talks on memory [1]." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const agent = new SelfAgent(readerFor(h, appKey), { fetch });
    expect(await agent.servePublicOnce()).toBe(0);
    const v = visitor("sam");
    const q = await v.ask("Talks?");
    expect(await agent.servePublicOnce()).toBe(1);
    expect(bodies[0]).toContain(TALK);
    expect(bodies[0]).not.toContain(PRIVATE);
    expect(((await v.answer(q)) as PublicReply).sources.map((x) => x.title)).toEqual(["Talks"]);
  });
});
