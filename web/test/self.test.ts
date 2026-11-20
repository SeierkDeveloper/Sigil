// Your AI self: the rules and the model key saved encrypted, the owner's test
// chat, apps that answer as it, and "Ask my AI self" links relayed end to end.
// The model is a stand-in that records what it was given; nothing calls a real
// model or the network. The server must never hold a question, an answer, a
// rule, a memory or the model key in readable form.

import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanRules,
  newAskSession,
  openAskMessage,
  openIntro,
  parseAskFragment,
  sealAskMessage,
  type ModelCaller,
  type ModelRequest,
  type AskReply,
  randomId,
} from "@sigil/core";
import { count, dumpDb, harness, readerFor, signedUp, ORIGIN, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as self from "../src/vault/selfOps";
import { SelfAgent } from "../../connector/src/self";
import { pendingFor, AGENT_ONLINE_MS } from "../src/server/self";

const MODEL_KEY = "sk-ant-CANARY-modelkey-77c1";
const SECRET_FOOD = "CANARY-risotto-a91f";
const HEALTH = "CANARY-health-0b3e";
const QUESTION = "CANARY-question-what-food-do-you-love";

let h: Harness;
beforeEach(() => {
  h = harness();
});

/** Stands in for the provider: records every request, answers with a fixed text. */
function stubModel(answer: (req: ModelRequest) => string = () => `I love ${SECRET_FOOD} [1].`) {
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

/** A fetch that plays the Anthropic API, for code that builds its own model caller (the connector). */
function stubFetch(answer = `I love ${SECRET_FOOD} [1].`) {
  const bodies: string[] = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(
      JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: answer }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { bodies, fetch };
}

async function setup() {
  const s = await signedUp(h);
  const notes = s.data.folders[0];
  const health = await ops.addFolder(s.b.api, s.vault, "Health");
  await ops.createMemory(s.b.api, notes, { title: "Favourite food", body: `My favourite food is ${SECRET_FOOD}.` });
  await ops.createMemory(s.b.api, health, { title: "Blood test", body: `${HEALTH} food diary and results.` });
  await self.saveModel(s.b.api, s.vault, { provider: "anthropic", model: "claude-opus-5-5", apiKey: MODEL_KEY });
  await self.saveRules(s.b.api, s.vault, cleanRules({ name: "Sam's AI self", folderIds: [notes.id], denyTopics: ["salary"] }));
  const data = await ops.loadVault(s.b.api, s.vault);
  return { ...s, data, notes, health };
}

function asker(link: { id: string }, url: string) {
  const fragment = url.split("#")[1];
  const { publicKey, introKey } = parseAskFragment(fragment);
  const session = newAskSession(link.id, publicKey, introKey);
  const ask = async (text: string) => {
    const id = randomId();
    const ids = { linkId: link.id, sessionId: session.id, messageId: id };
    const res = await h.raw("POST", `ask/${link.id}/questions`, {
      body: { id, sessionId: session.id, askerKey: session.publicKey, sealed: sealAskMessage(session.key, ids, "q", { v: 1, text, history: [] }) },
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    });
    return { res, id, ids };
  };
  const poll = async (id: string) => (await h.raw("GET", `ask/${link.id}/questions/${id}`)).json() as Promise<{ status: string; answer?: string }>;
  const open = (ids: { linkId: string; sessionId: string; messageId: string }, box: string) => openAskMessage<AskReply>(session.key, ids, "a", box);
  return { publicKey, introKey, session, ask, poll, open };
}

describe("settings", () => {
  it("keeps the model key and the rules only as envelopes the vault opens", async () => {
    const s = await setup();
    expect(s.data.model).toEqual({ provider: "anthropic", model: "claude-opus-5-5", apiKey: MODEL_KEY });
    expect(s.data.self?.name).toBe("Sam's AI self");
    expect(s.data.self?.folderIds).toEqual([s.notes.id]);
    const db = dumpDb(h.db);
    expect(db).not.toContain(MODEL_KEY);
    expect(db).not.toContain("Sam's AI self");
    expect(db).not.toContain("salary");
    expect(h.sent.join("\n")).not.toContain(MODEL_KEY);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM vault_settings")).toBe(2);
    // The export holds the rules and which model, but not the key.
    const exported = JSON.stringify(ops.buildExport(s.data, []));
    expect(exported).toContain("Sam's AI self");
    expect(exported).toContain("claude-opus-5-5");
    expect(exported).not.toContain(MODEL_KEY);
  });

  it("are refused under a name the vault does not use, and removed for real", async () => {
    const s = await setup();
    await expect(s.b.api.put("settings/other", { value: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA" })).rejects.toMatchObject({ status: 404 });
    await expect(s.b.api.put("settings/model", { value: MODEL_KEY })).rejects.toMatchObject({ status: 400 });
    await self.saveModel(s.b.api, s.vault, null);
    expect((await ops.loadVault(s.b.api, s.vault)).model).toBeNull();
  });

  it("do not open in another vault", async () => {
    const s = await setup();
    const other = await signedUp(h);
    const env = (h.db.prepare("SELECT value FROM vault_settings WHERE name = 'model'").get() as { value: string }).value;
    h.db.prepare("INSERT INTO vault_settings (user_id, name, value, updated_at) VALUES ((SELECT user_id FROM keyslots WHERE kind = 'wallet' AND ref = ?), 'model', ?, 'x')").run(other.w.address.toLowerCase(), env);
    const loaded = await ops.loadVault(other.b.api, other.vault);
    expect(loaded.model).toBeNull();
    expect(loaded.unreadable).toBe(1);
    void s;
  });
});

describe("the test chat", () => {
  it("answers as the owner from the allowed folders only, and cites the memory used", async () => {
    const s = await setup();
    const { model, calls } = stubModel();
    const sentBefore = h.sent.length;
    const a = await self.askInVault(s.data, s.data.self!, model, "What food do you love?");
    expect(a.text).toContain(SECRET_FOOD);
    expect(a.citations.map((c) => c.title)).toEqual(["Favourite food"]);
    expect(calls[0].system).toContain(SECRET_FOOD);
    expect(calls[0].system).not.toContain(HEALTH);
    // The test chat sends nothing to the Sigil server.
    expect(h.sent.length).toBe(sentBefore);
    const refused = await self.askInVault(s.data, s.data.self!, model, "What is your salary?");
    expect(refused.refused).toBe("denied_topic");
    expect(calls).toHaveLength(1);
  });
});

describe("an ask link answered by the open vault", () => {
  it("relays the question and answer end to end, logs both sealed, and the server reads none of it", async () => {
    const s = await setup();
    const rules = cleanRules({ ...s.data.self, name: "Sam's AI self" });
    const { link, url } = await self.createLink(
      s.b.api,
      s.vault,
      s.data,
      { label: "For the book club", name: "Sam's AI self", greeting: "Ask me about food.", rules, expiresInDays: 7, maxUses: 5, perHour: 10, appId: null },
      ORIGIN,
    );
    expect(url.startsWith(`${ORIGIN}/ask/${link.id}#`)).toBe(true);
    const data = await ops.loadVault(s.b.api, s.vault);
    expect(self.linkUrl(ORIGIN, data.askLinks[0])).toBe(url);

    const a = asker(link, url);
    const info = (await (await h.raw("GET", `ask/${link.id}`)).json()) as { publicKey: string; intro: string; state: string; online: boolean; remaining: number };
    expect(info).toMatchObject({ publicKey: a.publicKey, state: "active", online: false, remaining: 5 });
    expect((await openIntro(a.introKey, link.id, info.intro)).greeting).toBe("Ask me about food.");

    // Nobody is there to answer: the link says so, and the question is not kept.
    const offline = await a.ask(QUESTION);
    expect(offline.res.status).toBe(503);
    expect((await offline.res.json()).code).toBe("offline");

    // The vault opens: its agent checks in, and the link is online.
    const { model, calls } = stubModel();
    const deps = { model, box: data.box!, boxPublic: data.boxPublic! };
    expect(await self.serveOnce(s.b.api, data, deps)).toBe(0);
    expect(((await (await h.raw("GET", `ask/${link.id}`)).json()) as { online: boolean }).online).toBe(true);

    const q = await a.ask(QUESTION);
    expect(q.res.status).toBe(201);
    expect((await a.poll(q.id)).status).toBe("waiting");
    expect(await self.serveOnce(s.b.api, data, deps)).toBe(1);
    expect(calls[0].messages.at(-1)?.content).toBe(QUESTION);
    expect(calls[0].system).not.toContain(HEALTH);

    const done = await a.poll(q.id);
    expect(done.status).toBe("answered");
    const reply = a.open(q.ids, done.answer!);
    // The asker gets the answer without the citation numbers that point into the vault.
    expect(reply).toEqual({ v: 1, text: `I love ${SECRET_FOOD}.`, refused: null });

    // The owner's log has the question and answer, sealed to the vault's own key.
    const log = await ops.loadLog(s.b.api);
    const entry = log.entries.find((e) => e.kind === "ask")!;
    expect(entry).toMatchObject({ appId: link.id, memoryId: q.id, count: 1 });
    const note = self.openAskNote(data.box!, entry)!;
    expect(note).toMatchObject({ via: "link", label: "For the book club", question: QUESTION, answer: `I love ${SECRET_FOOD}.`, citations: [{ title: "Favourite food" }] });

    // Stats for the owner.
    const links = await self.refreshLinks(s.b.api, data);
    expect(links[0]).toMatchObject({ uses: 1, answered: 1, online: true, label: "For the book club" });

    const db = dumpDb(h.db);
    for (const secret of [QUESTION, SECRET_FOOD, MODEL_KEY, "For the book club", "Ask me about food", HEALTH]) expect(db, secret).not.toContain(secret);
    expect(h.sent.join("\n")).not.toContain(QUESTION);
    expect(h.sent.join("\n")).not.toContain(MODEL_KEY);
  });

  it("refuses within the link's rules, and an asker with the wrong key cannot read the answer", async () => {
    const s = await setup();
    const { link, url } = await self.createLink(
      s.b.api,
      s.vault,
      s.data,
      { label: "Strict", name: "Sam", greeting: "", rules: cleanRules({ folderIds: [s.notes.id], denyTopics: ["food"] }), expiresInDays: 1, maxUses: 10, perHour: 10, appId: null },
      ORIGIN,
    );
    const data = await ops.loadVault(s.b.api, s.vault);
    const { model, calls } = stubModel();
    const deps = { model, box: data.box!, boxPublic: data.boxPublic! };
    await self.serveOnce(s.b.api, data, deps);
    const a = asker(link, url);
    const q = await a.ask("What food do you love?");
    await self.serveOnce(s.b.api, data, deps);
    const done = await a.poll(q.id);
    expect(a.open(q.ids, done.answer!).refused).toBe("denied_topic");
    expect(calls).toHaveLength(0);

    const stranger = newAskSession(link.id, a.publicKey, a.introKey);
    expect(() => openAskMessage(stranger.key, q.ids, "a", done.answer!)).toThrow();
  });

  it("answers no one who lacks the whole link, the server included", async () => {
    const s = await setup();
    const { link } = await self.createLink(s.b.api, s.vault, s.data, { label: "Friends", name: "Sam", greeting: "", rules: s.data.self!, expiresInDays: 7, maxUses: 10, perHour: 10, appId: null }, ORIGIN);
    const data = await ops.loadVault(s.b.api, s.vault);
    const { model, calls } = stubModel();
    const deps = { model, box: data.box!, boxPublic: data.boxPublic! };
    await self.serveOnce(s.b.api, data, deps);
    // The server knows the link's id and public key, but not the greeting key in its fragment.
    const pub = (await (await h.raw("GET", `ask/${link.id}`)).json()) as { publicKey: string };
    const forged = newAskSession(link.id, pub.publicKey);
    const id = randomId();
    const ids = { linkId: link.id, sessionId: forged.id, messageId: id };
    const res = await h.raw("POST", `ask/${link.id}/questions`, {
      body: { id, sessionId: forged.id, askerKey: forged.publicKey, sealed: sealAskMessage(forged.key, ids, "q", { v: 1, text: "What is in the notes?", history: [] }) },
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
    });
    expect(res.status).toBe(201);
    await self.serveOnce(s.b.api, data, deps).catch(() => undefined);
    // The model was never asked, and nothing that came back opens with the forged key.
    expect(calls).toHaveLength(0);
    const after = (await (await h.raw("GET", `ask/${link.id}/questions/${id}`)).json()) as { status: string; answer?: string };
    if (after.answer) expect(() => openAskMessage(forged.key, ids, "a", after.answer!)).toThrow();
  });

  it("stops at its expiry, its number of uses, its hourly limit and when revoked", async () => {
    const s = await setup();
    const make = (over: Partial<self.NewLinkInput>) =>
      self.createLink(s.b.api, s.vault, s.data, { label: "L", name: "N", greeting: "", rules: s.data.self!, expiresInDays: 1, maxUses: 2, perHour: 10, appId: null, ...over }, ORIGIN);
    const one = await make({ maxUses: 1 });
    const busy = await make({ perHour: 1, maxUses: 5 });
    const gone = await make({});
    const data = await ops.loadVault(s.b.api, s.vault);
    pendingFor(h.db, { kind: "vault", userId: (h.db.prepare("SELECT user_id FROM ask_links LIMIT 1").get() as { user_id: string }).user_id });

    const a1 = asker(one.link, one.url);
    expect((await a1.ask("first")).res.status).toBe(201);
    const second = await a1.ask("second");
    expect(second.res.status).toBe(410);
    expect((await second.res.json()).code).toBe("used_up");

    const a2 = asker(busy.link, busy.url);
    expect((await a2.ask("first")).res.status).toBe(201);
    const other = asker(busy.link, busy.url);
    expect((await other.ask("second")).res.status).toBe(429);

    await self.revokeLink(s.b.api, gone.link.id);
    const r = await asker(gone.link, gone.url).ask("hello");
    expect(r.res.status).toBe(410);
    expect((await r.res.json()).code).toBe("revoked");

    h.db.prepare("UPDATE ask_links SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", busy.link.id);
    expect(((await (await h.raw("GET", `ask/${busy.link.id}`)).json()) as { state: string }).state).toBe("expired");
    void data;
  });

  it("goes offline when the vault stops checking in, and one asker waits for one answer at a time", async () => {
    const s = await setup();
    const { link, url } = await self.createLink(s.b.api, s.vault, s.data, { label: "L", name: "N", greeting: "", rules: s.data.self!, expiresInDays: 1, maxUses: 10, perHour: 10, appId: null }, ORIGIN);
    const userId = (h.db.prepare("SELECT user_id FROM ask_links").get() as { user_id: string }).user_id;
    pendingFor(h.db, { kind: "vault", userId });
    const a = asker(link, url);
    expect((await a.ask("one")).res.status).toBe(201);
    const waiting = await a.ask("two");
    expect(waiting.res.status).toBe(429);
    expect((await waiting.res.json()).code).toBe("waiting");
    h.db.prepare("UPDATE ask_links SET agent_seen_at = ?").run(Date.now() - AGENT_ONLINE_MS - 1000);
    expect(((await (await h.raw("GET", `ask/${link.id}`)).json()) as { online: boolean }).online).toBe(false);
  });
});

describe("the AI self in the connector", () => {
  it("answers ask_self on the owner's machine with the owner's key, and logs it sealed", async () => {
    const s = await setup();
    const { appKey, appId } = await ops.connectApp(s.b.api, s.vault, { name: "Claude Desktop", kind: "claude-desktop" }, [s.notes, s.health]);
    const reader = readerFor(h, appKey);
    const stub = stubFetch();
    const agent = new SelfAgent(reader, { fetch: stub.fetch });
    await expect(agent.ask("What food do you love?")).rejects.toMatchObject({ status: 403, code: "self_off" });

    let data = await ops.loadVault(s.b.api, s.vault);
    await self.setAppSelf(s.b.api, s.vault, data, data.apps[0], true);
    data = await ops.loadVault(s.b.api, s.vault);
    expect(data.apps[0].canAskSelf).toBe(true);
    expect(dumpDb(h.db)).not.toContain(MODEL_KEY);

    const a = await agent.ask("What food do you love?");
    expect(a.text).toContain(SECRET_FOOD);
    expect(a.citations.map((c) => c.title)).toEqual(["Favourite food"]);
    // The model got the allowed folder, even though this app may also read Health.
    expect(stub.bodies[0]).toContain(SECRET_FOOD);
    expect(stub.bodies[0]).not.toContain(HEALTH);

    const log = await ops.loadLog(s.b.api);
    const asked = log.entries.find((e) => e.kind === "ask")!;
    expect(asked.appId).toBe(appId);
    expect(self.openAskNote(data.box!, asked)).toMatchObject({ via: "app", question: "What food do you love?" });
    // Its reads went through its own grants and are in the log too.
    expect(log.entries.some((e) => e.kind === "read" && e.appId === appId)).toBe(true);

    // The rules changed in the vault reach the app; turning it off stops it at once.
    await self.saveRules(s.b.api, s.vault, cleanRules({ ...data.self, denyTopics: ["food"] }));
    data = await ops.loadVault(s.b.api, s.vault);
    expect(await self.refreshAppSelf(s.b.api, s.vault, data)).toBe(1);
    expect((await agent.ask("What food do you love?")).refused).toBe("denied_topic");
    await self.setAppSelf(s.b.api, s.vault, data, data.apps[0], false);
    await expect(agent.ask("Anything?")).rejects.toMatchObject({ code: "self_off" });
    const db = dumpDb(h.db);
    for (const secret of [MODEL_KEY, SECRET_FOOD, "What food do you love?"]) expect(db, secret).not.toContain(secret);
  });

  it("serves a link the owner gave it, while the vault is closed", async () => {
    const s = await setup();
    const { appKey } = await ops.connectApp(s.b.api, s.vault, { name: "Home machine", kind: "other" }, [s.notes]);
    let data = await ops.loadVault(s.b.api, s.vault);
    await self.setAppSelf(s.b.api, s.vault, data, data.apps[0], true);
    data = await ops.loadVault(s.b.api, s.vault);
    const { link, url } = await self.createLink(
      s.b.api,
      s.vault,
      data,
      { label: "Answered at home", name: "Sam", greeting: "", rules: data.self!, expiresInDays: 3, maxUses: 3, perHour: 10, appId: data.apps[0].id },
      ORIGIN,
    );
    const agent = new SelfAgent(readerFor(h, appKey), { fetch: stubFetch().fetch });
    // The open vault does not answer a link given to an app.
    await self.serveOnce(s.b.api, data, { model: stubModel().model, box: data.box!, boxPublic: data.boxPublic! });
    const a = asker(link, url);
    expect((await a.ask("hello?")).res.status).toBe(503);

    expect(await agent.serveOnce()).toBe(0);
    const q = await a.ask("What food do you love?");
    expect(q.res.status).toBe(201);
    expect(await agent.serveOnce()).toBe(1);
    const done = await a.poll(q.id);
    expect(a.open(q.ids, done.answer!).text).toBe(`I love ${SECRET_FOOD}.`);

    // Revoking the app revokes its links.
    await ops.revokeApp(s.b.api, data.apps[0].id);
    const after = await a.ask("again");
    expect(after.res.status).toBe(410);
  });
});
