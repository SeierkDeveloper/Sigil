// The AI self at work: drafts in an approval queue the server cannot read,
// nothing sent on its own, answers held for approval and then sent through the
// channel they came from, and edits turned into notes in "How I write" that
// later drafts use. Every step in the read log.

import { beforeEach, describe, expect, it } from "vitest";
import { cleanRules, newAskSession, openAskMessage, parseAskFragment, randomId, sealAskMessage, STYLE_FOLDER, type AskReply, type ModelCaller, type ModelRequest } from "@sigil/core";
import { count, dumpDb, harness, signedUp, ORIGIN, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as self from "../src/vault/selfOps";
import * as work from "../src/vault/workOps";

let h: Harness;
beforeEach(() => {
  h = harness();
});

const MESSAGE = "Subject: The invoice\n\nCANARY-message Could you confirm when the invoice will be paid?";

function stub(answer: (r: ModelRequest) => string) {
  const calls: ModelRequest[] = [];
  const model: ModelCaller = { provider: "anthropic", model: "claude-opus-5-5", complete: async (r) => (calls.push(r), answer(r)) };
  return { model, calls };
}

const steps = async (api: Parameters<typeof ops.loadLog>[0]) => (await ops.loadLog(api)).entries.filter((e) => e.kind === "work").map((e) => e.memoryId);

describe("drafting a reply", () => {
  it("without a model, writes a plain draft; approved with an edit, the edit becomes a note later drafts use", async () => {
    const o = await signedUp(h);
    let data = o.data;
    const draft = await work.draftReply(o.b.api, o.vault, data, { message: MESSAGE, from: "Alex Example <alex@example.org>" }, { model: null });
    expect(draft.state).toBe("waiting");
    expect(draft.record).toMatchObject({ kind: "reply", usedModel: false, title: "Reply to Alex Example" });
    expect(draft.record!.draft.startsWith("Hi Alex,")).toBe(true);
    expect(draft.record!.draft).toContain("about The invoice");
    // The queue is ciphertext on the server.
    const db = dumpDb(h.db);
    expect(db).not.toContain("CANARY-message");
    expect(db).not.toContain("Hi Alex");

    data = await ops.loadVault(o.b.api, o.vault);
    expect(data.drafts).toHaveLength(1);
    const edited = "Hey Alex,\n\nThanks, it goes out on Friday.\n\nCheers,\nSam";
    const out = await work.approve(o.b.api, o.vault, data, data.drafts[0], edited, { model: null, settings: data.work });
    expect(out.draft.state).toBe("approved");
    expect(out.createdFolder).toBe(true);
    expect(out.folder?.name).toBe(STYLE_FOLDER);
    expect(out.lesson?.body).toContain("Greeting: Hey {name},");
    expect(out.lesson?.body).toContain("Sign-off: Cheers,\\nSam");
    expect(out.lesson?.source).toEqual({ kind: "style" });

    data = await ops.loadVault(o.b.api, o.vault);
    expect(work.lessons(data)).toHaveLength(1);
    const next = await work.draftReply(o.b.api, o.vault, data, { message: "Lunch on Friday?", from: "Robin" }, { model: null });
    expect(next.record!.draft.startsWith("Hey Robin,")).toBe(true);
    expect(next.record!.draft.endsWith("Cheers,\nSam")).toBe(true);

    // Decided once: it cannot be approved again or put back.
    const row = h.db.prepare("SELECT id, box FROM drafts WHERE state = 'approved'").get() as { id: string; box: string };
    await expect(o.b.api.put(`drafts/${row.id}`, { box: row.box, state: "waiting" })).rejects.toMatchObject({ status: 409 });
    await expect(o.b.api.put(`drafts/${row.id}`, { box: row.box, state: "discarded" })).rejects.toMatchObject({ status: 409 });
    expect(await steps(o.b.api)).toEqual(expect.arrayContaining(["drafted-reply", "approved-reply", "learned"]));
  });

  it("with the owner's model, drafts from the self's folders and lets the model write the note, style only", async () => {
    const o = await signedUp(h);
    const notes = o.data.folders[0];
    await ops.createMemory(o.b.api, notes, { title: "Invoices", body: "CANARY-fact Invoices are paid on Fridays." });
    await self.saveRules(o.b.api, o.vault, cleanRules({ name: "Sam's AI self", folderIds: [notes.id] }));
    let data = await ops.loadVault(o.b.api, o.vault);
    const m = stub((r) => (r.system.includes("what the edit says about how the owner writes") ? "- Prefers short replies.\n- Sign-off: Thanks" : "Hello Alex, it will be paid on Friday. Kind regards"));
    const d = await work.draftReply(o.b.api, o.vault, data, { message: MESSAGE, from: "Alex" }, { model: m.model });
    expect(m.calls[0].system).toContain("CANARY-fact");
    expect(m.calls[0].system).toContain("you send nothing");
    expect(d.record).toMatchObject({ usedModel: true, sources: [{ title: "Invoices" }] });
    data = await ops.loadVault(o.b.api, o.vault);
    const out = await work.approve(o.b.api, o.vault, data, data.drafts[0], "Paid Friday. Thanks", { model: m.model, settings: data.work });
    expect(out.lesson?.body).toBe("Prefers short replies.\nSign-off: Thanks");
    expect(m.calls[1].system).toContain("describe style, not content");
  });

  it("learns nothing when learning is off, or when the draft was approved as written", async () => {
    const o = await signedUp(h);
    await work.saveWork(o.b.api, o.vault, { ...o.data.work, learn: false });
    let data = await ops.loadVault(o.b.api, o.vault);
    expect(data.work.learn).toBe(false);
    await work.draftReply(o.b.api, o.vault, data, { message: MESSAGE, from: "Alex" }, { model: null });
    data = await ops.loadVault(o.b.api, o.vault);
    expect((await work.approve(o.b.api, o.vault, data, data.drafts[0], "Changed entirely.", { model: null, settings: data.work })).lesson).toBeNull();
    await work.saveWork(o.b.api, o.vault, { ...data.work, learn: true });
    data = await ops.loadVault(o.b.api, o.vault);
    await work.draftReply(o.b.api, o.vault, data, { message: MESSAGE, from: "Alex" }, { model: null });
    data = await ops.loadVault(o.b.api, o.vault);
    const waiting = data.drafts.find((d) => d.state === "waiting")!;
    expect((await work.approve(o.b.api, o.vault, data, waiting, waiting.record!.draft, { model: null, settings: data.work })).lesson).toBeNull();
    expect(count(h.db, "SELECT COUNT(*) AS n FROM read_log WHERE kind = 'work' AND memory_id = 'learned'")).toBe(0);
  });

  it("lets the owner change and delete what it learned, each on the record", async () => {
    const o = await signedUp(h);
    let data = o.data;
    await work.draftReply(o.b.api, o.vault, data, { message: MESSAGE, from: "Alex" }, { model: null });
    data = await ops.loadVault(o.b.api, o.vault);
    await work.approve(o.b.api, o.vault, data, data.drafts[0], "Hey Alex,\n\nYes.\n\nBest,\nSam", { model: null, settings: data.work });
    data = await ops.loadVault(o.b.api, o.vault);
    const note = work.lessons(data)[0];
    await work.editLesson(o.b.api, data, note, "Greeting: Hello {name},");
    data = await ops.loadVault(o.b.api, o.vault);
    expect(work.hintsFor(data).greeting).toBe("Hello {name},");
    await work.deleteLesson(o.b.api, work.lessons(data)[0]);
    data = await ops.loadVault(o.b.api, o.vault);
    expect(work.lessons(data)).toHaveLength(0);
    expect(await steps(o.b.api)).toEqual(expect.arrayContaining(["lesson-edited", "lesson-deleted"]));
  });
});

describe("planning the week", () => {
  it("drafts from calendar memories wherever they are, and discarding keeps nothing sent", async () => {
    const o = await signedUp(h);
    const cal = await ops.addFolder(o.b.api, o.vault, "Calendar");
    const t = new Date(Date.now() + 86_400_000);
    t.setHours(10, 0, 0, 0);
    const p = (n: number) => String(n).padStart(2, "0");
    const when = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} 10:00 to ${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} 11:00`;
    await ops.createMemory(o.b.api, cal, { title: "CANARY-dentist", body: `When: ${when}`, source: { kind: "calendar", ref: "e1" }, createdAt: t.toISOString() });
    let data = await ops.loadVault(o.b.api, o.vault);
    const d = await work.draftPlan(o.b.api, o.vault, data, "", { model: null });
    expect(d.record!.draft).toContain("10:00 to 11:00: CANARY-dentist");
    expect(d.record!.sources).toEqual([expect.objectContaining({ title: "CANARY-dentist" })]);
    data = await ops.loadVault(o.b.api, o.vault);
    const gone = await work.discard(o.b.api, o.vault, data.drafts[0]);
    expect(gone.state).toBe("discarded");
    await work.removeDraft(o.b.api, gone.id);
    expect((await ops.loadVault(o.b.api, o.vault)).drafts).toHaveLength(0);
    expect(await steps(o.b.api)).toEqual(expect.arrayContaining(["drafted-plan", "discarded-plan"]));
  });
});

describe("answers held for approval", () => {
  it("are drafted once, not sent, and go out through the ask link only when approved, as edited", async () => {
    const o = await signedUp(h);
    const notes = o.data.folders[0];
    await ops.createMemory(o.b.api, notes, { title: "Food", body: "I like CANARY-soup." });
    await self.saveModel(o.b.api, o.vault, { provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-test" });
    await self.saveRules(o.b.api, o.vault, cleanRules({ name: "Sam's AI self", folderIds: [notes.id] }));
    await work.saveWork(o.b.api, o.vault, { ...o.data.work, holdLinks: true });
    let data = await ops.loadVault(o.b.api, o.vault);
    const { link, url } = await self.createLink(
      o.b.api,
      o.vault,
      data,
      { label: "Friends", name: "Sam's AI self", greeting: "Hi", rules: cleanRules({ ...data.self, name: "Sam's AI self" }), expiresInDays: 7, maxUses: 5, perHour: 10, appId: null },
      ORIGIN,
    );
    data = await ops.loadVault(o.b.api, o.vault);
    const m = stub(() => "I like CANARY-soup [1].");

    // The vault checks in so the link is online, then a guest asks.
    expect(await work.holdLinksOnce(o.b.api, o.vault, data, data.drafts, { model: m.model })).toHaveLength(0);
    const { publicKey } = parseAskFragment(url.split("#")[1]);
    const session = newAskSession(link.id, publicKey);
    const qid = randomId();
    const ids = { linkId: link.id, sessionId: session.id, messageId: qid };
    const res = await h.raw("POST", `ask/${link.id}/questions`, {
      body: { id: qid, sessionId: session.id, askerKey: session.publicKey, sealed: sealAskMessage(session.key, ids, "q", { v: 1, text: "What food do you like?", history: [] }) },
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    });
    expect(res.status).toBe(201);

    expect(await work.holdLinksOnce(o.b.api, o.vault, data, data.drafts, { model: m.model })).toHaveLength(1);
    data = await ops.loadVault(o.b.api, o.vault);
    // Drafted once, not twice; nothing was sent to the asker.
    expect(await work.holdLinksOnce(o.b.api, o.vault, data, data.drafts, { model: m.model })).toHaveLength(0);
    const poll = async () => (await (await h.raw("GET", `ask/${link.id}/questions/${qid}`)).json()) as { status: string; answer?: string };
    expect((await poll()).status).toBe("waiting");
    const held = data.drafts[0];
    expect(held.record).toMatchObject({ kind: "answer", input: "What food do you like?", draft: "I like CANARY-soup.", channel: { kind: "link", linkId: link.id } });

    await work.approve(o.b.api, o.vault, data, held, "I like CANARY-soup, and bread.", { model: null, settings: { ...data.work, learn: false } });
    const done = await poll();
    expect(done.status).toBe("answered");
    expect(openAskMessage<AskReply>(session.key, ids, "a", done.answer!)).toEqual({ v: 1, text: "I like CANARY-soup, and bread.", refused: null });
    expect(dumpDb(h.db)).not.toContain("CANARY-soup");
    const log = await ops.loadLog(o.b.api);
    expect(log.entries.some((e) => e.kind === "ask" && e.memoryId === qid)).toBe(true);
  });
});
