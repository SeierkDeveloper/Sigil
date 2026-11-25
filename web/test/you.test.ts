// A model of you through the real router: the state is one envelope the server
// cannot read, lessons come from the chosen folders only, the ranker trains on
// the owner's choices, the lessons reach an app only when shared and only
// through the Self card folder, and the AI self reads them.

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RULES, type ModelCaller, type ModelRequest } from "@sigil/core";
import { formatProfile } from "../../connector/src/server";
import { dumpDb, harness, readerFor, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import { selfProfile } from "../src/vault/selfOps";
import * as you from "../src/vault/youOps";

const CANARY = "CANARY-lesson-short-replies";
let h: Harness;
beforeEach(() => {
  h = harness();
});

function stub(lines: string, seen: ModelRequest[] = []): ModelCaller {
  return {
    provider: "anthropic",
    model: "stand-in",
    async complete(req) {
      seen.push(req);
      return lines;
    },
  };
}

async function vaultWithNotes() {
  const s = await signedUp(h);
  const notes = s.data.folders[0];
  const secret = await ops.addFolder(s.b.api, s.vault, "Private");
  for (let i = 1; i <= 6; i++) await ops.createMemory(s.b.api, notes, { title: `Reply ${i}`, body: `Kept it short again, reply number ${i}.` });
  await ops.createMemory(s.b.api, secret, { title: "Diary", body: "NOT-FOR-LESSONS" });
  const data = await ops.loadVault(s.b.api, s.vault);
  return { ...s, notes, secret, data };
}

describe("a model of you", () => {
  it("learns lessons only from the chosen folders and keeps everything in one envelope", async () => {
    const s = await vaultWithNotes();
    const seen: ModelRequest[] = [];
    let state = { ...s.data.you, folders: [s.notes.id] };
    state = await you.learnLessons(s.data, state, stub(`style | ${CANARY} | 1, 2\npriority | Answers the same day. | 3`, seen));
    expect(seen[0].messages[0].content).toContain("Reply 6");
    expect(seen[0].messages[0].content).not.toContain("NOT-FOR-LESSONS");
    expect(state.lessons.map((l) => l.kind)).toEqual(["style", "priority"]);
    await you.saveYou(s.b.api, s.vault, state);
    expect(dumpDb(h.db)).not.toContain(CANARY);
    const back = await ops.loadVault(s.b.api, s.vault);
    expect(back.you.lessons[0].text).toBe(CANARY);
    expect(back.you.history).toHaveLength(1);
  });

  it("trains on choices in the browser and saves the weights with the history", async () => {
    const s = await vaultWithNotes();
    const ids = s.data.memories.filter((m) => m.folderId === s.notes.id).map((m) => m.id);
    let state = { ...s.data.you, folders: [s.notes.id] };
    for (let i = 0; i < 12; i++) state = you.addChoice(state, ids[i % 3], ids[3 + (i % 3)]);
    state = you.trainOnDevice(s.data, state);
    expect(state.ranker?.trainedOn).toBe(12);
    expect(state.score?.tested).toBe(2);
    await you.saveYou(s.b.api, s.vault, state);
    expect((await ops.loadVault(s.b.api, s.vault)).you.ranker?.weights).toBe(state.ranker?.weights);
  });

  it("reaches an app only when shared and only through the Self card folder", async () => {
    const s = await vaultWithNotes();
    const { appKey } = await ops.connectApp(s.b.api, s.vault, { name: "Claude Desktop", kind: "claude-desktop" }, [s.notes]);
    const reader = readerFor(h, appKey);
    let state = await you.learnLessons(s.data, { ...s.data.you, folders: [s.notes.id] }, stub(`style | ${CANARY} | 1`));
    // Not shared: nothing is written.
    expect(await you.syncYouMemory(s.b.api, s.vault, s.data, state)).toMatchObject({ written: null });
    state = { ...state, shareWithApps: true };
    const r = await you.syncYouMemory(s.b.api, s.vault, s.data, state);
    expect(r.written?.source.kind).toBe("model");
    expect(r.folder?.kind).toBe("profile");
    let data = you.withYouMemory(s.data, r);
    // The app has no Self card folder yet.
    expect(await reader.lessons()).toBeNull();
    data = await ops.loadVault(s.b.api, s.vault);
    await ops.setAppFolders(s.b.api, s.vault, data.apps[0], [s.notes, ops.profileFolder(data)!]);
    const lessons = await reader.lessons();
    expect(lessons?.body).toContain(CANARY);
    expect(formatProfile(null, lessons)).toContain("# A model of you");
    // Writing again edits the same memory; turning it off deletes it.
    const again = await you.syncYouMemory(s.b.api, s.vault, data, state);
    expect(again.written?.id).toBe(r.written?.id);
    data = await ops.loadVault(s.b.api, s.vault);
    expect(data.memories.filter((m) => m.source.kind === "model")).toHaveLength(1);
    expect((await you.syncYouMemory(s.b.api, s.vault, data, { ...state, shareWithApps: false })).removed).toHaveLength(1);
    expect(await reader.lessons()).toBeNull();
  });

  it("gives the AI self the lessons when its rules let it read the Self card", async () => {
    const s = await vaultWithNotes();
    const state = await you.learnLessons(s.data, { ...s.data.you, folders: [s.notes.id] }, stub(`limit | ${CANARY} | 1`));
    const r = await you.syncYouMemory(s.b.api, s.vault, s.data, { ...state, shareWithApps: true });
    const data = { ...you.withYouMemory(s.data, r), you: state };
    const folder = ops.profileFolder(data)!;
    expect(selfProfile(data, { ...DEFAULT_RULES, folderIds: [s.notes.id] })).toBeNull();
    expect(selfProfile(data, { ...DEFAULT_RULES, folderIds: [folder.id] })).toContain(CANARY);
  });

  it("says plainly when there is too little to learn from", async () => {
    const s = await signedUp(h);
    await expect(you.learnLessons(s.data, { ...s.data.you, folders: [s.data.folders[0].id] }, stub(""))).rejects.toThrow(/at least 3 memories/);
  });
});
