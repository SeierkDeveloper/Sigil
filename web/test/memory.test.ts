// Shared memory: a family's history on a space, with stories, people and
// photos, who added what, rules that keep what others wrote, and heirs who
// become members when a member's legacy plan releases. Through the real
// router, the legacy release included.

import { beforeEach, describe, expect, it } from "vitest";
import { encodeBundle } from "@sigil/core";
import { count, dumpDb, harness, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as agents from "../src/vault/agentOps";
import * as memory from "../src/vault/memoryOps";
import * as legacy from "../src/vault/legacyOps";
import * as storage from "../src/vault/storageOps";
import { heirsTick } from "../src/server/spaces";

const STORY = "CANARY-family-story-90";
const PHOTO = { type: "image/jpeg" as const, data: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDAoMDQ" };
const DAY = 86_400_000;

let h: Harness;
beforeEach(() => {
  h = harness();
});

const load = (who: Awaited<ReturnType<typeof signedUp>>) => ops.loadVault(who.b.api, who.vault);
const code = (who: Awaited<ReturnType<typeof signedUp>>) => ops.vaultCode(who.data)!.code;

async function family() {
  const sam = await signedUp(h);
  const kim = await signedUp(h);
  const ana = await signedUp(h);
  const id = await memory.createMemorySpace(sam.b.api, sam.data, { name: "The Rivers family", kind: "family", about: "Since the summer house", myName: "Sam" });
  let space = (await load(sam)).spaces.find((s) => s.id === id)!;
  expect(space).toMatchObject({ kind: "family", about: "Since the summer house", name: "The Rivers family" });
  await agents.addVaultMember(sam.b.api, space, code(kim), "Kim", "write");
  await agents.acceptSpace(kim.b.api, id);
  space = (await load(sam)).spaces.find((s) => s.id === id)!;
  return { sam, kim, ana, id, space };
}

describe("a shared memory", () => {
  it("is a timeline of stories with photos and people, saying who added what, encrypted with the space key", async () => {
    const f = await family();
    const grandma = await memory.addPerson(f.sam.b.api, f.space, { name: "Grandma Ines", relation: "grandmother", about: "Kept bees.", member: null });
    await memory.addStory(f.sam.b.api, f.space, { title: "The summer house", text: `Built in one summer. ${STORY}`, when: "1962-07", people: [grandma.id], image: PHOTO });
    const kimSpace = (await load(f.kim)).spaces.find((s) => s.id === f.id)!;
    await memory.addStory(f.kim.b.api, kimSpace, { title: "The boat", text: "Painted blue.", when: "1970", people: [] });
    const space = (await load(f.sam)).spaces.find((s) => s.id === f.id)!;
    const byLabel = Object.fromEntries(space.members.map((m) => [m.id, m.label]));
    const stories = space.memories.filter((m) => m.source.kind === "story");
    expect(stories.map((s) => [s.title, s.when, byLabel[s.author!]])).toEqual(
      expect.arrayContaining([
        ["The summer house", "1962-07", "Sam"],
        ["The boat", "1970", "Kim"],
      ]),
    );
    expect(stories.find((s) => s.title === "The summer house")?.image).toEqual(PHOTO);
    const html = memory.historyDocument(space);
    expect(html).toContain("<h2>1962</h2>");
    expect(html).toContain("Added by Kim");
    expect(html).toContain("With Grandma Ines");
    expect(html).toContain(`data:image/jpeg;base64,${PHOTO.data}`);
    expect(html.indexOf("The summer house")).toBeLessThan(html.indexOf("The boat"));
    expect(dumpDb(h.db) + h.sent.join("\n")).not.toContain(STORY);
    // A team space is not a shared memory, and the other way round.
    expect(memory.memorySpaces(await load(f.sam)).map((s) => s.id)).toEqual([f.id]);
    expect(memory.teamSpaces(await load(f.sam))).toEqual([]);
  });

  it("keeps what others wrote: a writer changes and deletes only their own, and leaving deletes nothing", async () => {
    const f = await family();
    const story = await memory.addStory(f.sam.b.api, f.space, { title: "Sam's story", text: STORY, when: "1980", people: [] });
    const kimSpace = (await load(f.kim)).spaces.find((s) => s.id === f.id)!;
    await expect(memory.addStory(f.kim.b.api, kimSpace, { title: "Changed by Kim", text: "x", when: "", people: [] }, story.id)).rejects.toMatchObject({ code: "not_author" });
    await expect(agents.deleteSpaceMemory(f.kim.b.api, f.id, story.id)).rejects.toMatchObject({ code: "not_author" });
    const own = await memory.addStory(f.kim.b.api, kimSpace, { title: "Kim's own", text: "y", when: "", people: [] });
    await agents.deleteSpaceMemory(f.kim.b.api, f.id, own.id);
    // Sam, an admin, may not delete the whole history while Kim is in it.
    await expect(agents.deleteSpace(f.sam.b.api, f.id)).rejects.toMatchObject({ code: "others_wrote" });
    // Kim leaves: Sam's story stays, and so does Kim's next one, written before leaving.
    await memory.addStory(f.kim.b.api, kimSpace, { title: "Kim's last", text: "z", when: "", people: [] });
    await memory.leaveSpace(f.kim.b.api, f.id);
    expect((await load(f.kim)).spaces).toEqual([]);
    const space = (await load(f.sam)).spaces.find((s) => s.id === f.id)!;
    expect(space.memories.map((m) => m.title).sort()).toEqual(["Kim's last", "Sam's story"]);
    // The last admin hands the space on before leaving; the last member may delete it.
    await expect(memory.leaveSpace(f.sam.b.api, f.id)).rejects.toMatchObject({ code: "last_member" });
    await agents.deleteSpace(f.sam.b.api, f.id);
    // Deleting an account never deletes what it wrote for others.
    const g = await family();
    const kimSpace2 = (await load(g.kim)).spaces.find((s) => s.id === g.id)!;
    await memory.addStory(g.kim.b.api, kimSpace2, { title: "Kim's account goes", text: "kept", when: "", people: [] });
    await ops.deleteAccount(g.kim.b.api);
    expect((await load(g.sam)).spaces.find((s) => s.id === g.id)!.memories.map((m) => m.title)).toEqual(["Kim's account goes"]);
  });

  it("names an heir who becomes a member when the named member's legacy plan releases", async () => {
    const f = await family();
    await memory.addStory(f.sam.b.api, f.space, { title: "The summer house", text: STORY, when: "1962", people: [] });
    const samMember = f.space.me.id;
    await memory.nameHeir(f.sam.b.api, f.space, { code: code(f.ana), label: "Ana", role: "read", forMember: samMember });
    let space = (await load(f.sam)).spaces.find((s) => s.id === f.id)!;
    expect(space.heirs).toEqual([expect.objectContaining({ label: "Ana", role: "read", forMember: samMember, trusted: true })]);
    // Ana is not a member yet, and sees nothing.
    expect((await load(f.ana)).spaces).toEqual([]);

    // Removing Kim gives the space a new key: the heir is sealed again with it.
    await agents.removeMembers(f.sam.b.api, space, [space.members.find((m) => m.label === "Kim")!.id]);
    space = (await load(f.sam)).spaces.find((s) => s.id === f.id)!;
    expect(space.epoch).toBe(2);
    expect(space.heirs[0].trusted).toBe(true);

    // Sam's legacy plan names Ana; Sam is away for the whole period and Ana opens her share.
    const data = await load(f.sam);
    await legacy.saveLegacy(f.sam.b.api, f.sam.vault, data, {
      owner: "Sam",
      periodDays: 90,
      threshold: 1,
      includeModel: false,
      people: [{ id: "person-ana-1", label: "Ana", publicKey: f.ana.data.boxPublic, invite: null, folderIds: [data.folders[0].id], self: false }],
    });
    const samId = String((h.db.prepare("SELECT user_id FROM legacy_plans").get() as { user_id: string }).user_id);
    h.db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(new Date(Date.now() - 91 * DAY).toISOString(), samId);
    let trusted = (await load(f.ana)).trusted[0];
    await legacy.requestRelease(f.ana.b.api, trusted.planId);
    trusted = (await load(f.ana)).trusted[0];
    await legacy.openRelease(f.ana.b.api, f.ana.vault, f.ana.data.box!, trusted);

    // The release made Ana a member, with the role she was named with; she accepts and reads the history.
    let anaData = await load(f.ana);
    expect(anaData.spaces.map((s) => [s.id, s.me.role, s.me.acceptedAt])).toEqual([[f.id, "read", null]]);
    await agents.acceptSpace(f.ana.b.api, f.id);
    anaData = await load(f.ana);
    const hers = anaData.spaces[0];
    expect(hers.untrusted).toEqual([]);
    expect(hers.memories.map((m) => m.body)).toEqual([STORY]);
    expect(hers.heirs).toEqual([]);
    const log = await ops.loadLog(f.ana.b.api);
    expect(log.entries.some((e) => e.kind === "space" && e.memoryId === `heir-${f.id}`)).toBe(true);
    // Read only, as named.
    await expect(memory.addStory(f.ana.b.api, hers, { title: "x", text: "y", when: "", people: [] })).rejects.toThrow(/read only/);
    expect(heirsTick(h.db)).toBe(0);
  });

  it("refuses heirs for a team space, and travels in each member's bundle", async () => {
    const f = await family();
    await memory.addStory(f.sam.b.api, f.space, { title: "In the bundle", text: STORY, when: "", people: [] });
    const team = await agents.createSpace(f.sam.b.api, f.sam.data, "Work", "Sam");
    const teamView = (await load(f.sam)).spaces.find((s) => s.id === team)!;
    await expect(memory.nameHeir(f.sam.b.api, teamView, { code: code(f.ana), label: "Ana", role: "read", forMember: null })).rejects.toThrow(/shared memory/);
    const bundle = await storage.makeBundle(f.kim.b.api, f.kim.vault);
    const tables = bundle.body.parts.spaces.map((x) => (x as { table: string }).table);
    expect(tables.filter((t) => t === "space_memories")).toHaveLength(1);
    expect(JSON.stringify(encodeBundle(bundle))).not.toContain(STORY);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM spaces WHERE kind = 'family'")).toBe(1);
  });
});
