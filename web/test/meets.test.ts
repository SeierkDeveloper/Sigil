// Selves meet selves: an invite by vault code, an answer, turns taken by each
// owner's AI self with its own model, rules and folders, encrypted between the
// two vaults so the relay sees only ciphertext, a turn limit, stop, and every
// step in both owners' logs.

import { beforeEach, describe, expect, it } from "vitest";
import { cleanRules, formatVaultCode, isMeetBox, isSealed, type ModelCaller, type ModelRequest } from "@sigil/core";
import { dumpDb, harness, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as self from "../src/vault/selfOps";
import * as meet from "../src/vault/meetOps";

const SAM_CAL = "CANARY-dentist-sam";
const SAM_PRIVATE = "CANARY-sam-diary";
const ROBIN_WORK = "CANARY-robin-book";

let h: Harness;
beforeEach(() => {
  h = harness();
});

function stub(answer: (r: ModelRequest) => string) {
  const calls: ModelRequest[] = [];
  const model: ModelCaller = { provider: "anthropic", model: "claude-opus-5-5", complete: async (r) => (calls.push(r), answer(r)) };
  return { model, calls };
}

async function owner(name: string, memories: { folder: string; title: string; body: string; source?: { kind: "calendar"; ref: string } }[]) {
  const s = await signedUp(h);
  const folders = new Map<string, Awaited<ReturnType<typeof ops.addFolder>>>();
  for (const m of memories) {
    if (!folders.has(m.folder)) folders.set(m.folder, await ops.addFolder(s.b.api, s.vault, m.folder));
    await ops.createMemory(s.b.api, folders.get(m.folder)!, { title: m.title, body: m.body, source: m.source });
  }
  await self.saveRules(s.b.api, s.vault, cleanRules({ name: `${name}'s AI self`, denyTopics: ["salary"] }));
  const data = await ops.loadVault(s.b.api, s.vault);
  return { ...s, name, folders, data, code: formatVaultCode(data.boxPublic!) };
}

const reload = async (o: Awaited<ReturnType<typeof owner>>) => ({ ...o, data: await ops.loadVault(o.b.api, o.vault) });

describe("selves meet", () => {
  it("talk only after both said yes, end to end encrypted, within the turn limit, logged on both sides", async () => {
    let sam = await owner("Sam", [
      { folder: "Calendar", title: "Dentist", body: `${SAM_CAL} When: 2026-11-24 10:00 to 11:00`, source: { kind: "calendar", ref: "evt1" } },
      { folder: "Diary", title: "Diary", body: SAM_PRIVATE },
    ]);
    let robin = await owner("Robin", [{ folder: "Work", title: "Book", body: `${ROBIN_WORK} I am writing a book.` }]);

    const id = await meet.inviteSelf(sam.b.api, sam.vault, {
      code: robin.code,
      purpose: "find_time",
      note: "CANARY-note 30 minutes next week",
      label: "Robin",
      me: "Sam",
      folderIds: [],
      calendar: true,
      turnLimit: 4,
    });
    sam = await reload(sam);
    robin = await reload(robin);
    expect(sam.data.meets[0]).toMatchObject({ id, role: "inviter", state: "invited", purpose: "find_time", note: "CANARY-note 30 minutes next week" });
    expect(robin.data.meets[0]).toMatchObject({ id, role: "invitee", state: "invited", purpose: "find_time", peerName: "Sam" });

    // Nothing is said before the other side says yes.
    const samModel = stub((r) => (r.system.includes(SAM_CAL) ? "I am free on Tuesday at 14:00." : "I have nothing."));
    const robinModel = stub(() => "Tuesday at 14:00 works for Robin. [done]");
    expect(await meet.meetOnce(sam.b.api, sam.vault, sam.data, { model: samModel.model })).toBe(0);
    await expect(sam.b.api.post(`meets/${id}/turns`, { turn: 1, box: "m1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA", done: false, cited: 0 })).rejects.toMatchObject({ status: 409 });

    await meet.acceptMeet(robin.b.api, robin.vault, robin.data.meets[0], { label: "Sam", me: "Robin", folderIds: [robin.folders.get("Work")!.id], calendar: false });
    sam = await reload(sam);
    expect(sam.data.meets[0]).toMatchObject({ state: "running", peerName: "Robin", next: "me" });

    // Turn 1, Sam's self: from its calendar memories only.
    expect(await meet.meetOnce(sam.b.api, sam.vault, sam.data, { model: samModel.model })).toBe(1);
    expect(samModel.calls[0].system).toContain(SAM_CAL);
    expect(samModel.calls[0].system).not.toContain(SAM_PRIVATE);
    // Robin cannot write Sam's turn.
    robin = await reload(robin);
    expect(robin.data.meets[0].next).toBe("me");
    // Turn 2, Robin's self, which ends it.
    expect(await meet.meetOnce(robin.b.api, robin.vault, robin.data, { model: robinModel.model })).toBe(1);
    expect(robinModel.calls[0].messages[0]).toEqual({ role: "user", content: "I am free on Tuesday at 14:00." });
    expect(robinModel.calls[0].system).not.toContain(SAM_CAL);

    sam = await reload(sam);
    robin = await reload(robin);
    for (const o of [sam, robin]) {
      const m = o.data.meets[0];
      expect(m.state).toBe("done");
      expect(m.lines.map((l) => [l.turn, l.text])).toEqual([
        [1, "I am free on Tuesday at 14:00."],
        [2, "Tuesday at 14:00 works for Robin."],
      ]);
      expect(m.lines.every((l) => l.ok)).toBe(true);
    }
    expect(sam.data.meets[0].lines[0].mine).toBe(true);
    expect(robin.data.meets[0].lines[0].mine).toBe(false);

    // The relay saw only boxes.
    const row = h.db.prepare("SELECT invite, answer FROM meets").get() as { invite: string; answer: string };
    expect(isSealed(row.invite) && isSealed(row.answer)).toBe(true);
    for (const m of h.db.prepare("SELECT box FROM meet_messages").all() as { box: string }[]) expect(isMeetBox(m.box)).toBe(true);
    const db = dumpDb(h.db);
    for (const plain of ["Tuesday at 14:00", SAM_CAL, "CANARY-note", "find_time", "Robin"]) expect(db, plain).not.toContain(plain);

    // Both logs have every step, sealed with the hour.
    for (const o of [sam, robin]) {
      const steps = (await ops.loadLog(o.b.api)).entries.filter((e) => e.kind === "meet" && e.appId === id).map((e) => e.memoryId);
      expect(steps).toEqual(expect.arrayContaining(["invited", "accepted", "turn-1", "turn-2", "done"]));
    }
    // The export holds the transcript, opened on the device.
    expect(ops.buildExport(sam.data, []).meets[0]).toMatchObject({ with: "Robin", purpose: "find_time", state: "done", transcript: [{ turn: 1, by: "my AI self" }, { turn: 2, by: "Robin's AI self" }] });

    // Over: no more turns.
    await expect(sam.b.api.post(`meets/${id}/turns`, { turn: 3, box: "m1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA", done: false, cited: 0 })).rejects.toMatchObject({ status: 409 });
  });

  it("can be declined, or stopped by either side; a stranger cannot see it", async () => {
    let sam = await owner("Sam", []);
    let robin = await owner("Robin", []);
    const a = await meet.inviteSelf(sam.b.api, sam.vault, { code: robin.code, purpose: "swap_intros", note: "", label: "Robin", me: "Sam", folderIds: [], calendar: false, turnLimit: 6 });
    robin = await reload(robin);
    await meet.declineMeet(robin.b.api, a);
    sam = await reload(sam);
    expect(sam.data.meets[0].state).toBe("declined");

    const b = await meet.inviteSelf(sam.b.api, sam.vault, { code: robin.code, purpose: "collab_fit", note: "", label: "Robin", me: "Sam", folderIds: [], calendar: false, turnLimit: 6 });
    robin = await reload(robin);
    await meet.acceptMeet(robin.b.api, robin.vault, robin.data.meets.find((m) => m.id === b)!, { label: "Sam", me: "Robin", folderIds: [], calendar: false });
    await meet.stopMeet(robin.b.api, b);
    sam = await reload(sam);
    expect(sam.data.meets.find((m) => m.id === b)).toMatchObject({ state: "stopped", stoppedBy: "peer" });

    const stranger = await owner("Eve", []);
    expect(stranger.data.meets).toEqual([]);
    await expect(stranger.b.api.post(`meets/${b}/stop`)).rejects.toMatchObject({ status: 404 });
    await expect(meet.inviteSelf(sam.b.api, sam.vault, { code: sam.code, purpose: "swap_intros", note: "", label: "me", me: "Sam", folderIds: [], calendar: false, turnLimit: 4 })).rejects.toMatchObject({ status: 400 });

    // Removing: gone from one list, kept in the other until both removed it.
    await meet.removeMeet(sam.b.api, b);
    expect((await reload(sam)).data.meets.some((m) => m.id === b)).toBe(false);
    expect((await reload(robin)).data.meets.some((m) => m.id === b)).toBe(true);
  });

  it("keeps each self within its own rules", async () => {
    let sam = await owner("Sam", [{ folder: "Work", title: "Work", body: "I build tools." }]);
    let robin = await owner("Robin", []);
    const id = await meet.inviteSelf(sam.b.api, sam.vault, { code: robin.code, purpose: "collab_fit", note: "", label: "Robin", me: "Sam", folderIds: [sam.folders.get("Work")!.id], calendar: false, turnLimit: 4 });
    robin = await reload(robin);
    await meet.acceptMeet(robin.b.api, robin.vault, robin.data.meets[0], { label: "Sam", me: "Robin", folderIds: [], calendar: false });
    sam = await reload(sam);
    await meet.meetOnce(sam.b.api, sam.vault, sam.data, { model: stub(() => "I build tools. What is your salary?").model });
    robin = await reload(robin);
    const r = stub(() => "unused");
    await meet.meetOnce(robin.b.api, robin.vault, robin.data, { model: r.model });
    // Robin's rules deny the topic: refused without the model.
    expect(r.calls).toHaveLength(0);
    robin = await reload(robin);
    expect(robin.data.meets[0].lines[1].text).toBe("That is something I don't talk about here.");
    void id;
  });
});
