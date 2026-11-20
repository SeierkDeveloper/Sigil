// Legacy: a plan made on the owner's device, the heartbeat and its warnings,
// invites, the release room, and what a trusted person can open once the owner
// has been inactive for the whole period. The server never holds a share or
// the legacy key in readable form.

import { beforeEach, describe, expect, it } from "vitest";
import { encodeBoxPublicKey, newBoxKeyPair, type ModelCaller } from "@sigil/core";
import { count, dumpDb, harness, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as legacy from "../src/vault/legacyOps";
import { legacyTick } from "../src/server/legacy";
import type { Api } from "../src/vault/api";

const CANARY = "CANARY-legacy-plaintext-3c1";
const DAY = 86_400_000;

let h: Harness;
beforeEach(() => {
  h = harness();
});

const model: ModelCaller = {
  provider: "anthropic",
  model: "test-model",
  async complete(req) {
    return req.system.includes("legacy mode") ? "We kept bees every summer [1]." : "wrong mode";
  },
};

async function setup() {
  const owner = await signedUp(h);
  const family = await ops.addFolder(owner.b.api, owner.vault, "Family");
  const work = await ops.addFolder(owner.b.api, owner.vault, "Work");
  await ops.createMemory(owner.b.api, family, { title: "The bees", body: `Bees at the summer house. ${CANARY}` });
  await ops.createMemory(owner.b.api, work, { title: "Project notes", body: "The work notes." });
  const ana = await signedUp(h);
  const ben = await signedUp(h);
  const cy = await signedUp(h);
  const data = await ops.loadVault(owner.b.api, owner.vault);
  const draft: legacy.LegacyDraft = {
    owner: "Sam",
    periodDays: 90,
    threshold: 2,
    includeModel: false,
    people: [
      { id: "person-ana-1", label: "Ana", publicKey: ana.data.boxPublic, invite: null, folderIds: [family.id], self: true },
      { id: "person-ben-1", label: "Ben", publicKey: ben.data.boxPublic, invite: null, folderIds: [work.id], self: false },
      { id: "person-cy-12", label: "Cy", publicKey: cy.data.boxPublic, invite: null, folderIds: [family.id, work.id], self: false },
    ],
  };
  const state = await legacy.saveLegacy(owner.b.api, owner.vault, data, draft);
  return { owner, ana, ben, cy, family, work, draft, state };
}

function away(days: number, userId?: string) {
  const at = new Date(Date.now() - days * DAY).toISOString();
  if (userId) h.db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(at, userId);
}

function ownerId(): string {
  return String((h.db.prepare("SELECT user_id FROM legacy_plans").get() as { user_id: string }).user_id);
}

const load = (who: { b: { api: Api }; vault: ops.Unlocked }) => ops.loadVault(who.b.api, who.vault);

describe("making a plan", () => {
  it("stores only sealed boxes and envelopes, and shows the owner the next check-in", async () => {
    const s = await setup();
    expect(s.state.plan).toMatchObject({ epoch: 1, threshold: 2, periodDays: 90, stage: 0 });
    expect(s.state.record?.people.map((p) => p.label)).toEqual(["Ana", "Ben", "Cy"]);
    const due = Date.parse(s.state.plan!.dueAt) - Date.parse(s.state.lastActiveAt!);
    expect(due).toBe(90 * DAY);
    const db = dumpDb(h.db);
    expect(db).not.toContain(CANARY);
    for (const word of ["Ana", "Ben", "Family", "Sam"]) expect(db).not.toContain(`"${word}"`);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM legacy_people WHERE share IS NOT NULL")).toBe(3);
    const log = await ops.loadLog(s.owner.b.api);
    expect(log.entries.map((e) => [e.kind, e.memoryId])).toEqual([["legacy", "made"]]);
    // The export says who receives what, in plain words, and leaves the legacy key out.
    const exported = ops.buildExport(await load(s.owner), log.entries);
    expect(exported.legacy).toMatchObject({ owner: "Sam", periodDays: 90, threshold: 2 });
    expect(exported.legacy?.people.map((p) => [p.label, p.folders, p.aiSelf])).toEqual([
      ["Ana", ["Family"], true],
      ["Ben", ["Work"], false],
      ["Cy", ["Family", "Work"], false],
    ]);
    expect(JSON.stringify(exported)).not.toContain(s.state.record!.key);
    expect((ops.buildExport(await load(s.ana), [])).namedIn).toEqual([{ owner: "Sam", as: "Ana", folders: ["Family"] }]);
  });

  it("tells each trusted person they are named, and hands out no share while the owner is active", async () => {
    const s = await setup();
    const ana = await load(s.ana);
    expect(ana.trusted).toHaveLength(1);
    expect(ana.trusted[0]).toMatchObject({ state: "waiting", mine: null, note: { owner: "Sam", label: "Ana", folders: ["Family"], self: true, threshold: 2, total: 3 } });
    await expect(legacy.requestRelease(s.ana.b.api, ana.trusted[0].planId)).rejects.toMatchObject({ code: "not_releasable" });
    await expect(s.ana.b.api.get(`legacy/plans/${ana.trusted[0].planId}/bundle`)).rejects.toMatchObject({ status: 403 });
    // A vault that is not named sees nothing.
    const other = await signedUp(h);
    expect((await load(other)).trusted).toEqual([]);
    await expect(other.b.api.get(`legacy/plans/${ana.trusted[0].planId}/bundle`)).rejects.toMatchObject({ code: "not_trustee" });
  });

  it("refuses the owner's own vault as a trusted person", async () => {
    const owner = await signedUp(h);
    const data = await ops.loadVault(owner.b.api, owner.vault);
    const draft = { owner: "Sam", periodDays: 90, threshold: 1, includeModel: false, people: [{ id: "person-self1", label: "Me", publicKey: data.boxPublic, invite: null, folderIds: [data.folders[0].id], self: false }] };
    await expect(legacy.saveLegacy(owner.b.api, owner.vault, data, draft)).rejects.toMatchObject({ code: "own_vault" });
  });
});

describe("the heartbeat", () => {
  it("writes each warning stage once, then opens the plan for release", async () => {
    const s = await setup();
    const owner = ownerId();
    away(70, owner);
    legacyTick(h.db);
    away(85, owner);
    legacyTick(h.db);
    legacyTick(h.db);
    away(91, owner);
    legacyTick(h.db);
    const steps = (h.db.prepare("SELECT memory_id FROM read_log WHERE kind = 'legacy' ORDER BY at, rowid").all() as { memory_id: string }[]).map((r) => r.memory_id);
    expect(steps).toEqual(["made", "warning-first", "warning-last", "release-open"]);
    expect((await load(s.ana)).trusted[0].state).toBe("open");
  });

  it("counts any vault action as alive, and keeps the missed warning to show once", async () => {
    const s = await setup();
    away(80, ownerId());
    legacyTick(h.db);
    const back = await load(s.owner);
    expect(back.legacy.plan).toMatchObject({ stage: 0, missed: { stage: 1 } });
    await legacy.dismissMissed(s.owner.b.api);
    expect((await load(s.owner)).legacy.plan?.missed).toBeNull();
    const checked = await legacy.checkIn(s.owner.b.api, s.owner.vault);
    expect(checked.plan?.stage).toBe(0);
    const log = await ops.loadLog(s.owner.b.api);
    expect(log.entries.map((e) => e.memoryId)).toContain("check-in");
  });
});

describe("a release", () => {
  async function released() {
    const s = await setup();
    away(91, ownerId());
    let ana = (await load(s.ana)).trusted[0];
    await legacy.requestRelease(s.ana.b.api, ana.planId);
    expect(legacy.sharesInHand(ana)).toBe(1);
    // One share is not enough.
    await expect(legacy.openRelease(s.ana.b.api, s.ana.vault, s.ana.data.box!, ana)).rejects.toMatchObject({ code: "too_few" });

    const ben = (await load(s.ben)).trusted[0];
    expect(ben.requests.map((r) => r.personId)).toEqual(["person-ana-1"]);
    expect(await legacy.passToRequesters(s.ben.b.api, ben)).toBe(1);
    expect(await legacy.passToRequesters(s.ben.b.api, { ...ben, passedTo: ["person-ana-1"] })).toBe(0);

    ana = (await load(s.ana)).trusted[0];
    expect(legacy.sharesInHand(ana)).toBe(2);
    const kept = await legacy.openRelease(s.ana.b.api, s.ana.vault, s.ana.data.box!, ana);
    return { s, kept, ana };
  }

  it("combines shares in the browser and opens exactly the folders left to that person", async () => {
    const { s, kept } = await released();
    expect(kept.bundle.folders.map((f) => f.id)).toEqual([s.family.id]);
    const vault = await legacy.loadReleased(s.ana.b.api, kept.bundle);
    expect(vault.folders.map((f) => f.name)).toEqual(["Family"]);
    expect(vault.memories.map((m) => m.title)).toEqual(["The bees"]);
    expect(vault.memories[0].body).toContain(CANARY);
    // The copy kept in Ana's own vault opens after a reload, without combining again.
    const again = (await load(s.ana)).trusted[0];
    expect(again.kept?.bundle.folders.map((f) => f.id)).toEqual([s.family.id]);
    expect(dumpDb(h.db) + h.sent.join("\n")).not.toContain(CANARY);
  });

  it("answers as the AI self in legacy mode, and logs the question sealed for the owner", async () => {
    const { s, kept } = await released();
    const vault = await legacy.loadReleased(s.ana.b.api, kept.bundle);
    const answer = await legacy.askLegacySelf(s.ana.b.api, kept.bundle, vault, model, "What did we do in summer?");
    expect(answer.text).toBe("We kept bees every summer [1].");
    expect(answer.citations.map((c) => c.title)).toEqual(["The bees"]);
    // Ben was not given the AI self.
    const benBundle = { ...kept.bundle, self: null };
    await expect(legacy.askLegacySelf(s.ben.b.api, benBundle, vault, model, "x")).rejects.toThrow("did not leave you");

    const ownerBack = await load(s.owner);
    const log = await ops.loadLog(s.owner.b.api);
    const steps = log.entries.filter((e) => e.kind === "legacy").map((e) => e.memoryId!.replace(/^ask-.*/, "ask"));
    expect(steps.reverse()).toEqual(["made", "warning-first", "warning-last", "release-open", "request", "share-passed", "released", "opened", "read", "ask"]);
    const askEntry = log.entries.find((e) => e.memoryId?.startsWith("ask-"))!;
    expect(askEntry.appId).toBe("person-ana-1");
    const note = legacy.openLegacyAskNote(ownerBack.box!, ownerBack.legacy.plan!.id, askEntry);
    expect(note).toMatchObject({ via: "legacy", question: "What did we do in summer?", answer: "We kept bees every summer [1]." });
  });

  it("closes again when the owner comes back, and a new epoch makes every old share useless", async () => {
    const { s, ana: old } = await released();
    const ownerBack = await load(s.owner);
    expect(ownerBack.legacy.plan).toMatchObject({ stage: 0, missed: { stage: 3 } });
    expect(ownerBack.legacy.plan?.releasedAt).toBeTruthy();
    expect(ownerBack.legacy.plan?.people.find((p) => p.id === "person-ana-1")?.openedAt).toBeTruthy();
    const planId = ownerBack.legacy.plan!.id;
    await expect(s.ana.b.api.get(`legacy/plans/${planId}/folders`)).rejects.toMatchObject({ code: "not_releasable" });

    // Ana keeps her old shares in memory; the owner seals again.
    const next = await legacy.resealLegacy(s.owner.b.api, s.owner.vault, ownerBack);
    expect(next?.plan?.epoch).toBe(2);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM legacy_passes")).toBe(0);
    away(91, ownerId());
    const fresh = (await load(s.ana)).trusted[0];
    expect(fresh.epoch).toBe(2);
    await expect(legacy.openRelease(s.ana.b.api, s.ana.vault, s.ana.data.box!, { ...fresh, received: [{ from: "person-ben-1", share: old.received[0].share }] })).rejects.toMatchObject({
      code: "mismatch",
    });
  });
});

describe("invites", () => {
  it("adds a person by link: their vault answers with its key, the owner's vault checks the tag, then seals their share", async () => {
    const s = await setup();
    let data = await load(s.owner);
    const dee = legacy.newInvitePerson("Dee", [s.family.id], false);
    await legacy.saveLegacy(s.owner.b.api, s.owner.vault, data, { ...s.draft, people: [...s.draft.people, dee] });
    const link = legacy.inviteLink("http://localhost:3000", dee)!;

    const invited = await signedUp(h);
    const invite = await legacy.readInvite(invited.b.api, new URL(link).hash);
    expect(invite).toMatchObject({ owner: "Sam", label: "Dee", answered: false });
    // The owner cannot answer their own invite, and nobody can answer with another vault's key.
    await expect(legacy.acceptInvite(s.owner.b.api, data, invite)).rejects.toMatchObject({ code: "own_vault" });
    await expect(legacy.acceptInvite(invited.b.api, { boxPublic: s.ana.data.boxPublic }, invite)).rejects.toMatchObject({ status: 400 });
    await legacy.acceptInvite(invited.b.api, invited.data, invite);
    await expect(legacy.acceptInvite(invited.b.api, invited.data, invite)).rejects.toMatchObject({ code: "answered" });
    expect((await ops.loadLog(s.owner.b.api)).entries[0]).toMatchObject({ kind: "legacy", appId: dee.id, memoryId: "invite-answered" });

    data = await load(s.owner);
    expect(data.legacy.answers[dee.id]).toEqual({ publicKey: invited.data.boxPublic, verified: true });
    const people = data.legacy.record!.people.map((p) => (p.id === dee.id ? { ...p, publicKey: data.legacy.answers[dee.id].publicKey } : p));
    await legacy.saveLegacy(s.owner.b.api, s.owner.vault, data, { ...s.draft, people });
    const named = (await load(invited)).trusted;
    expect(named.map((t) => t.note?.label)).toEqual(["Dee"]);
  });

  it("catches a key the server swapped into an invite answer", async () => {
    const s = await setup();
    const data = await load(s.owner);
    const dee = legacy.newInvitePerson("Dee", [s.family.id], false);
    await legacy.saveLegacy(s.owner.b.api, s.owner.vault, data, { ...s.draft, people: [...s.draft.people, dee] });
    const invited = await signedUp(h);
    await legacy.acceptInvite(invited.b.api, invited.data, await legacy.readInvite(invited.b.api, new URL(legacy.inviteLink("http://x", dee)!).hash));
    h.db.prepare("UPDATE legacy_people SET invite_key = ? WHERE id = ?").run(encodeBoxPublicKey(newBoxKeyPair().publicKey), dee.id);
    expect((await load(s.owner)).legacy.answers[dee.id].verified).toBe(false);
  });

  it("waits with no shares at all while too few people have accepted", async () => {
    const owner = await signedUp(h);
    const data = await ops.loadVault(owner.b.api, owner.vault);
    const a = legacy.newInvitePerson("A", [data.folders[0].id], false);
    const b = legacy.newInvitePerson("B", [data.folders[0].id], false);
    const state = await legacy.saveLegacy(owner.b.api, owner.vault, data, { owner: "Sam", periodDays: 180, threshold: 2, includeModel: false, people: [a, b] });
    expect(state.plan?.people.every((p) => !p.sealed)).toBe(true);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM legacy_people WHERE share IS NOT NULL")).toBe(0);
  });
});

describe("changing and cancelling", () => {
  it("refuses a stale change and cancels for good", async () => {
    const s = await setup();
    const data = await load(s.owner);
    await legacy.saveLegacy(s.owner.b.api, s.owner.vault, data, s.draft);
    // A second device still holding epoch 1 cannot overwrite epoch 2.
    await expect(legacy.saveLegacy(s.owner.b.api, s.owner.vault, data, s.draft)).rejects.toMatchObject({ code: "stale" });
    await legacy.cancelLegacy(s.owner.b.api);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM legacy_people")).toBe(0);
    expect((await load(s.ana)).trusted).toEqual([]);
    const log = await ops.loadLog(s.owner.b.api);
    expect(log.entries.map((e) => e.memoryId)).toEqual(["cancelled", "changed", "made"]);
  });
});
