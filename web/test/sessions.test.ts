// Sessions with an expert's public AI self, through the real router: the owner
// opens times, a visitor books one with an intake sealed in their browser,
// asks within the session's time and number of questions, every answer comes
// from the public copy under the house rules, the owner reads the transcript,
// and can end a session or block its visitor. The model is played by the test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanOffer, cleanRules, type ModelCaller, type ModelRequest } from "@sigil/core";
import { count, dumpDb, harness, ORIGIN, readerFor, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as pub from "../src/vault/publicOps";
import * as sessions from "../src/vault/sessionOps";
import { handleApi } from "../src/server/api";
import { SelfAgent } from "../../connector/src/self";

const INTAKE = "CANARY-intake-tomatoes-61";
const QUESTION = "When does compost go on? CANARY-question-soil-4d";
// Monday 2026-11-23, 14:10 UTC: inside the first slot of the day.
const NOW = new Date("2026-11-23T14:10:00.000Z");

let h: Harness;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h = harness();
});
afterEach(() => vi.useRealTimers());

function stubModel() {
  const calls: ModelRequest[] = [];
  const model: ModelCaller = { provider: "anthropic", model: "claude-opus-5-5", complete: async (r) => (calls.push(r), "Add compost in autumn [1].") };
  return { model, calls };
}

/** A visitor's browser: no cookie, its own address. */
const browser = (ip: string) => (input: string, init: RequestInit = {}) => {
  if (typeof init.body === "string") h.sent.push(init.body);
  const url = new URL(input, ORIGIN);
  const headers = new Headers(init.headers);
  headers.set("x-forwarded-for", ip);
  return handleApi(new Request(url, { ...init, headers }), url.pathname.replace(/^\/api\//, "").split("/"), h.db);
};

const OFFER = cleanOffer({
  enabled: true,
  topics: ["Soil", "Vegetables"],
  turns: 2,
  slotMinutes: 30,
  windows: [{ days: [1], from: "14:00", to: "16:00" }],
  timeZone: "UTC",
  intake: [{ id: "grow", label: "What do you grow?", required: true }],
  houseRules: "Not professional advice. Check local rules before spraying anything.",
  perDay: 2,
});

async function expert() {
  const s = await signedUp(h);
  const garden = await ops.addFolder(s.b.api, s.vault, "Garden");
  await ops.createMemory(s.b.api, garden, { title: "Compost", body: "Compost goes on in autumn." });
  let data = await ops.loadVault(s.b.api, s.vault);
  await pub.savePublic(s.b.api, s.vault, data, {
    handle: "gardener",
    name: "The gardener's AI self",
    greeting: "Ask about soil.",
    rules: cleanRules({ tone: "Short." }),
    folderIds: [garden.id],
    perVisitorHour: 5,
    showAnswers: true,
    enabled: true,
    appId: null,
  });
  await sessions.saveOffer(s.b.api, OFFER);
  data = await ops.loadVault(s.b.api, s.vault);
  // The owner's open vault checks in, so the page and the session show it online.
  await pub.pendingPublic(s.b.api);
  return { ...s, data };
}

describe("a session", () => {
  it("is booked with a sealed intake, answered under the house rules, and kept as a transcript for the owner", async () => {
    const e = await expert();
    const visitor = browser("198.51.100.20");
    const offer = await sessions.loadOffer("gardener", visitor);
    expect(offer.offer?.houseRules).toContain("Not professional advice");
    expect(offer.slots.map((s) => s.start)).toEqual(["2026-11-23T14:00:00.000Z", "2026-11-23T14:30:00.000Z", "2026-11-23T15:00:00.000Z", "2026-11-23T15:30:00.000Z", "2026-11-30T14:00:00.000Z", "2026-11-30T14:30:00.000Z", "2026-11-30T15:00:00.000Z", "2026-11-30T15:30:00.000Z"]);
    const booked = await sessions.bookSession(ORIGIN, offer, { slotStart: offer.slots[0].start, topic: "Soil", name: "Robin", answers: { grow: `Tomatoes. ${INTAKE}` } }, visitor);
    expect(booked.url).toBe(`${ORIGIN}/s/${booked.id}#${booked.secret}`);
    // The slot is taken now.
    expect((await sessions.loadOffer("gardener", visitor)).slots[0].start).toBe("2026-11-23T14:30:00.000Z");

    const { client, status } = await sessions.SessionClient.open(booked.id, booked.secret, visitor);
    expect(status).toMatchObject({ topic: "Soil", turns: 2, used: 0, state: "booked", online: true, problem: null, houseRules: OFFER.houseRules });
    const qid = await client.ask(status, QUESTION, []);

    // The owner's open vault answers: only from the public copy, told the house rules and the intake.
    const { model, calls } = stubModel();
    let data = await ops.loadVault(e.b.api, e.vault);
    expect(await pub.servePublicOnce(e.b.api, data, { model })).toBe(1);
    expect(calls[0].system).toContain("House rules the owner set for every session");
    expect(calls[0].system).toContain("Check local rules before spraying anything.");
    expect(calls[0].system).toContain(INTAKE);
    expect(calls[0].system).toContain("Compost goes on in autumn.");
    const r = await client.poll(status, qid);
    expect(r).toMatchObject({ status: "answered", reply: { text: "Add compost in autumn.", sources: [{ title: "Compost" }] } });

    // The owner sees the booking, the intake and the transcript, opened on their device; the wall stays empty.
    data = await ops.loadVault(e.b.api, e.vault);
    const b = data.sessions.bookings[0];
    expect(b).toMatchObject({ id: booked.id, topic: "Soil", used: 1, consent: OFFER.consent });
    expect(b.intake).toMatchObject({ name: "Robin", topic: "Soil", consent: OFFER.consent });
    expect(b.intake?.answers[0].answer).toContain(INTAKE);
    expect(b.transcript).toEqual([expect.objectContaining({ turn: 1, question: QUESTION, answer: "Add compost in autumn." })]);
    expect(data.publicSelf?.wall).toEqual([]);
    const log = await ops.loadLog(e.b.api);
    expect(log.entries.filter((x) => x.kind === "session").map((x) => x.memoryId)).toEqual([`turn-${booked.id}-1`, `booked-${booked.id}`]);
    // Neither the intake nor the question nor the answer reached the node readable.
    const wire = dumpDb(h.db) + h.sent.join("\n");
    expect(wire).not.toContain(INTAKE);
    expect(wire).not.toContain(QUESTION);
    expect(wire).not.toContain("Add compost in autumn");
  });

  it("holds as many questions as the offer says, within its time, and only for its link", async () => {
    const e = await expert();
    const visitor = browser("198.51.100.21");
    const offer = await sessions.loadOffer("gardener", visitor);
    const booked = await sessions.bookSession(ORIGIN, offer, { slotStart: offer.slots[0].start, topic: "Soil", name: "", answers: { grow: "Beans" } }, visitor);
    const { client, status } = await sessions.SessionClient.open(booked.id, booked.secret, visitor);
    const { model } = stubModel();
    for (const text of ["one", "two"]) {
      await client.ask(status, text, []);
      await pub.servePublicOnce(e.b.api, await ops.loadVault(e.b.api, e.vault), { model });
    }
    await expect(client.ask(status, "three", [])).rejects.toThrow(/Every question of this session/);
    // Another booking's link is not this one's.
    await expect(sessions.SessionClient.open(booked.id, (await sessions.bookSession(ORIGIN, offer, { slotStart: offer.slots[1].start, topic: "Soil", name: "", answers: { grow: "x" } }, visitor)).secret, visitor)).rejects.toThrow(/does not work/);
    // A booking for later cannot be used yet; after its time it cannot be used at all.
    const later = await sessions.bookSession(ORIGIN, offer, { slotStart: "2026-11-30T14:00:00.000Z", topic: "Soil", name: "", answers: { grow: "x" } }, browser("198.51.100.22"));
    const l = await sessions.SessionClient.open(later.id, later.secret, visitor);
    expect(l.status.problem).toMatch(/not started/);
    await expect(l.client.ask(l.status, "early", [])).rejects.toThrow(/not started/);
    vi.setSystemTime(new Date("2026-11-30T14:31:00.000Z"));
    await expect(l.client.ask(l.status, "late", [])).rejects.toThrow(/over/);
  });

  it("keeps to the cap per day, and the owner can end a session or block its visitor", async () => {
    const e = await expert();
    const robin = browser("198.51.100.23");
    const offer = await sessions.loadOffer("gardener", robin);
    const first = await sessions.bookSession(ORIGIN, offer, { slotStart: offer.slots[0].start, topic: "Soil", name: "", answers: { grow: "x" } }, robin);
    await sessions.bookSession(ORIGIN, offer, { slotStart: offer.slots[1].start, topic: "Vegetables", name: "", answers: { grow: "x" } }, browser("198.51.100.24"));
    // Two a day: Monday is full.
    expect((await sessions.loadOffer("gardener", robin)).slots.every((s) => s.start.startsWith("2026-11-30"))).toBe(true);
    await expect(sessions.bookSession(ORIGIN, offer, { slotStart: offer.slots[2].start, topic: "Soil", name: "", answers: { grow: "x" } }, robin)).rejects.toThrow(/no longer free/);
    await expect(sessions.bookSession(ORIGIN, offer, { slotStart: "2026-11-30T14:00:00.000Z", topic: "Taxes", name: "", answers: { grow: "x" } }, robin)).rejects.toThrow(/topics offered/);

    await sessions.endSession(e.b.api, first.id, true);
    const { client, status } = await sessions.SessionClient.open(first.id, first.secret, robin);
    expect(status.state).toBe("blocked");
    await expect(client.ask(status, "hello", [])).rejects.toThrow(/closed by its host/);
    await expect(sessions.bookSession(ORIGIN, await sessions.loadOffer("gardener", robin), { slotStart: "2026-11-30T14:00:00.000Z", topic: "Soil", name: "", answers: { grow: "x" } }, robin)).rejects.toThrow(/does not take sessions from you/);
    const log = await ops.loadLog(e.b.api);
    expect(log.entries.some((x) => x.kind === "session" && x.memoryId === `blocked-${first.id}`)).toBe(true);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM session_blocks")).toBe(1);
  });

  it("is answered by the connector too, when the owner picked it to answer the public AI self", async () => {
    const e = await expert();
    const app = await ops.connectApp(e.b.api, e.vault, { name: "Connector", kind: "other" }, []);
    await (await import("../src/vault/selfOps")).saveModel(e.b.api, e.vault, { provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-test" });
    let data = await ops.loadVault(e.b.api, e.vault);
    await pub.savePublic(e.b.api, e.vault, data, { handle: "gardener", name: "The gardener's AI self", greeting: "", rules: cleanRules({}), folderIds: data.publicSelf!.secret!.folderIds, perVisitorHour: 5, showAnswers: true, enabled: true, appId: app.appId });
    const systems: string[] = [];
    const agent = new SelfAgent(readerFor(h, app.appKey), {
      fetch: async (_url, init) => {
        systems.push(JSON.parse(String(init?.body)).system);
        return Response.json({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Compost in autumn [1]." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
      },
    });
    await agent.servePublicOnce();
    const visitor = browser("198.51.100.25");
    const offer = await sessions.loadOffer("gardener", visitor);
    const booked = await sessions.bookSession(ORIGIN, offer, { slotStart: offer.slots[0].start, topic: "Soil", name: "", answers: { grow: `Leeks ${INTAKE}` } }, visitor);
    const { client, status } = await sessions.SessionClient.open(booked.id, booked.secret, visitor);
    const qid = await client.ask(status, "When do I add compost?", []);
    expect(await agent.servePublicOnce()).toBe(1);
    expect(systems[0]).toContain(INTAKE);
    expect(await client.poll(status, qid)).toMatchObject({ status: "answered", reply: { text: "Compost in autumn." } });
    data = await ops.loadVault(e.b.api, e.vault);
    expect(data.sessions.bookings[0].transcript[0]).toMatchObject({ turn: 1, question: "When do I add compost?" });
  });
});
