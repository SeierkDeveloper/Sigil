// Shared memory: stories and people encrypted with the space key, the
// timeline, heirs sealed like the members they will become, and the readable
// copy of the whole history.

import { describe, expect, it } from "vitest";
import {
  buildMemory,
  createSpace,
  decryptMemory,
  encodeBoxPublicKey,
  encryptMemory,
  historyHtml,
  memberTag,
  newBoxKeyPair,
  openSpaceKey,
  openSpaceMeta,
  openSpaceWithRaw,
  peopleOf,
  personDraft,
  rotateSpace,
  sealHeir,
  storyDraft,
  timeline,
  verifyMemberTag,
  whenLabel,
  type Memory,
} from "../src/index";

async function familySpace() {
  const me = newBoxKeyPair();
  const made = await createSpace("space-000001", "The Rivers family", { id: "member-00001", kind: "vault", publicKey: encodeBoxPublicKey(me.publicKey), role: "admin" }, { kind: "family", about: "Since 1950" });
  return { me, made, space: await openSpaceWithRaw("space-000001", made.meta, made.raw) };
}

describe("a shared memory", () => {
  it("keeps its kind and its line about it inside the encrypted meta, and through a new key", async () => {
    const { made, space } = await familySpace();
    expect(await openSpaceMeta("space-000001", made.meta, made.raw)).toEqual({ name: "The Rivers family", kind: "family", about: "Since 1950" });
    const r = await rotateSpace(space, 2, [], [], { name: space.name, kind: "family", about: "Since 1950" });
    expect(await openSpaceMeta("space-000001", r.meta, r.raw)).toMatchObject({ kind: "family" });
    // A team space keeps the meta it always had.
    const team = await createSpace("space-000002", "Work", { id: "member-00002", kind: "vault", publicKey: encodeBoxPublicKey(newBoxKeyPair().publicKey), role: "admin" });
    expect(await openSpaceMeta("space-000002", team.meta, team.raw)).toEqual({ name: "Work", kind: "team", about: "" });
  });

  it("holds stories with a date and the people in them, encrypted like any memory", async () => {
    const { space } = await familySpace();
    const grandma = buildMemory(personDraft({ name: "Grandma Ines", relation: "grandmother", about: "Kept bees.", member: null }), space.id, "person-00001");
    const story = buildMemory(storyDraft({ title: "The summer house", text: "We built it in one summer.", when: "1962-07", people: [grandma.id] }), space.id);
    const stored = await encryptMemory(space, story);
    expect(stored.head + stored.body).not.toContain("summer house");
    const back = await decryptMemory(space, stored);
    expect(back).toMatchObject({ when: "1962-07", people: [grandma.id], source: { kind: "story" } });
    expect(storyDraft({ title: "", text: "", when: "not a date", people: [], image: { type: "image/jpeg", data: "AAAA" } })).toMatchObject({ title: "A photo", when: null });
    expect(() => storyDraft({ title: " ", text: "", when: "", people: [] })).toThrow(/needs a title/);
    expect(() => personDraft({ name: " ", relation: "", about: "", member: null })).toThrow(/needs a name/);
    expect(peopleOf([grandma])).toEqual([{ id: "person-00001", name: "Grandma Ines", relation: "grandmother", about: "Kept bees.", member: null }]);
  });

  it("reads as a timeline by year, oldest first, and as a document to print", async () => {
    const { space } = await familySpace();
    const p = buildMemory(personDraft({ name: "Ines", relation: "grandmother", about: "", member: "member-00001" }), space.id, "person-00001");
    const mk = (title: string, when: string, created = "2026-11-20T10:00:00.000Z") =>
      ({ ...buildMemory(storyDraft({ title, text: `${title} <b>text</b>`, when, people: [p.id] }), space.id, undefined, created), author: "member-00001" }) as Memory & { author: string };
    const all = [mk("Wedding", "1970-06-12"), mk("House", "1962"), mk("Boat", "1970-02"), { ...p, author: "member-00001" }];
    const years = timeline(all);
    expect(years.map((y) => [y.year, y.stories.map((s) => s.title)])).toEqual([
      ["1962", ["House"]],
      ["1970", ["Boat", "Wedding"]],
    ]);
    expect(whenLabel("1970-06-12")).toBe("12 June 1970");
    expect(whenLabel("1970-02")).toBe("February 1970");
    const html = historyHtml({ name: "The family", about: "", kind: "family", members: { "member-00001": "Sam" }, people: peopleOf(all), memories: all, madeAt: "2026-11-20T12:00:00.000Z" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<h2>1962</h2>");
    expect(html).toContain("Added by Sam");
    expect(html).toContain("With Ines");
    expect(html).toContain("&lt;b&gt;text&lt;/b&gt;");
    expect(html).not.toContain("<b>text</b>");
    expect(html).not.toMatch(/<script/i);
  });

  it("names heirs whose key and tag are made as for the member they will become", async () => {
    const { made } = await familySpace();
    const heir = newBoxKeyPair();
    const sealed = await sealHeir(made.raw, "space-000001", 1, { id: "heir-0000001", publicKey: encodeBoxPublicKey(heir.publicKey), role: "write" });
    expect(openSpaceKey(heir, "space-000001", "heir-0000001", sealed.sealedKey).raw).toEqual(made.raw);
    const asMember = { id: "heir-0000001", kind: "vault" as const, publicKey: encodeBoxPublicKey(heir.publicKey), role: "write" as const };
    expect(sealed.tag).toBe(await memberTag(made.raw, "space-000001", asMember));
    expect(await verifyMemberTag(made.raw, "space-000001", { ...asMember, role: "admin" }, sealed.tag)).toBe(false);
  });
});
