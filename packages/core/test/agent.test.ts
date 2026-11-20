import { describe, expect, it } from "vitest";
import {
  agentBoxPair,
  agentHandoffKey,
  agentPublicKey,
  buildMemory,
  cleanAgentRules,
  cleanHandoff,
  createSpace,
  decryptMemory,
  DecryptError,
  encodeBoxPublicKey,
  encryptMemory,
  memberTag,
  newAppSecret,
  newBoxKeyPair,
  openHandoff,
  openSealedBytes,
  openSpaceKey,
  openSpaceWithRaw,
  rotateSpace,
  sealBytes,
  sealForMember,
  sealHandoff,
  spaceHandoffKey,
  untrustedMembers,
  utf8,
  fromUtf8,
  verifyMemberTag,
  type SpaceMember,
} from "../src/index";

const CANARY = "CANARY-agent-note-41";

describe("agent keys", () => {
  it("derives the same X25519 key pair from the app secret on the owner's device and in the connector", () => {
    const secret = newAppSecret();
    const a = agentBoxPair(secret);
    const b = agentBoxPair(secret.slice());
    expect(a.publicKey).toEqual(b.publicKey);
    expect(agentPublicKey(secret)).toBe(encodeBoxPublicKey(a.publicKey));
    expect(agentPublicKey(newAppSecret())).not.toBe(agentPublicKey(secret));
    // Something sealed to the agent opens with the derived pair only.
    const sealed = sealBytes(a.publicKey, utf8(CANARY), "space-key:s:m");
    expect(fromUtf8(openSealedBytes(b, sealed, "space-key:s:m"))).toBe(CANARY);
    expect(() => openSealedBytes(agentBoxPair(newAppSecret()), sealed, "space-key:s:m")).toThrow(DecryptError);
    expect(() => agentBoxPair(new Uint8Array(8))).toThrow();
  });

  it("cleans rules: forget is off unless turned on", () => {
    expect(cleanAgentRules({})).toEqual({ remember: true, recall: true, forget: false, handoff: true });
    expect(cleanAgentRules({ remember: false, forget: "yes", handoff: false })).toEqual({ remember: false, recall: true, forget: false, handoff: false });
    expect(cleanAgentRules({ forget: true }).forget).toBe(true);
  });

  it("seals handoff notes for the agent's next session, bound to the note's id", async () => {
    const secret = newAppSecret();
    const key = await agentHandoffKey(secret);
    const note = cleanHandoff({ from: "Cursor", text: `Next: finish the parser. ${CANARY}` });
    const env = await sealHandoff(key, "handoff1234", note);
    expect(env).not.toContain(CANARY);
    expect(await openHandoff(await agentHandoffKey(secret), "handoff1234", env)).toMatchObject({ from: "Cursor", text: note.text, to: null });
    await expect(openHandoff(key, "handoff9999", env)).rejects.toBeInstanceOf(DecryptError);
    await expect(openHandoff(await agentHandoffKey(newAppSecret()), "handoff1234", env)).rejects.toBeInstanceOf(DecryptError);
    expect(() => cleanHandoff({ text: "   " })).toThrow("needs some text");
  });
});

describe("team spaces", () => {
  async function space() {
    const owner = newBoxKeyPair();
    const friend = newBoxKeyPair();
    const agentSecret = newAppSecret();
    const creator: SpaceMember = { id: "member-owner", kind: "vault", publicKey: encodeBoxPublicKey(owner.publicKey), role: "admin" };
    const made = await createSpace("space12345", "Launch team", creator);
    return { owner, friend, agentSecret, creator, made };
  }

  it("seals the space key to each member's own key, vaults and agents alike", async () => {
    const s = await space();
    const opened = openSpaceKey(s.owner, "space12345", "member-owner", s.made.creator.sealedKey);
    expect(opened.raw).toEqual(s.made.raw);
    expect(opened.epoch).toBe(1);
    const open = await openSpaceWithRaw("space12345", s.made.meta, opened.raw);
    expect(open.name).toBe("Launch team");

    const agent: SpaceMember = { id: "member-agent", kind: "agent", publicKey: agentPublicKey(s.agentSecret), role: "write" };
    const sealed = await sealForMember(s.made.raw, "space12345", 1, agent);
    expect(openSpaceKey(agentBoxPair(s.agentSecret), "space12345", "member-agent", sealed.sealedKey).raw).toEqual(s.made.raw);
    expect(() => openSpaceKey(s.friend, "space12345", "member-agent", sealed.sealedKey)).toThrow(DecryptError);
    expect(() => openSpaceKey(agentBoxPair(s.agentSecret), "space12345", "member-owner", sealed.sealedKey)).toThrow(DecryptError);
  });

  it("tags members so a member the server added on its own is caught", async () => {
    const s = await space();
    const friend: SpaceMember = { id: "member-friend", kind: "vault", publicKey: encodeBoxPublicKey(s.friend.publicKey), role: "read" };
    const tag = await memberTag(s.made.raw, "space12345", friend);
    expect(await verifyMemberTag(s.made.raw, "space12345", friend, tag)).toBe(true);
    // A raised role, a swapped key or a key from another space all fail.
    expect(await verifyMemberTag(s.made.raw, "space12345", { ...friend, role: "admin" }, tag)).toBe(false);
    expect(await verifyMemberTag(s.made.raw, "space12345", { ...friend, publicKey: encodeBoxPublicKey(newBoxKeyPair().publicKey) }, tag)).toBe(false);
    expect(await verifyMemberTag(s.made.raw, "space99999", friend, tag)).toBe(false);
    const planted = { id: "member-x", kind: "vault" as const, publicKey: encodeBoxPublicKey(newBoxKeyPair().publicKey), role: "admin" as const, tag: "0".repeat(64) };
    expect(await untrustedMembers(s.made.raw, "space12345", [{ ...friend, tag }, planted])).toEqual(["member-x"]);
  });

  it("rotates on removal: memories encrypted again, the key sealed only to those who stay", async () => {
    const s = await space();
    const open = await openSpaceWithRaw("space12345", s.made.meta, s.made.raw);
    const memory = buildMemory({ title: "Launch plan", body: `Ship on Friday. ${CANARY}` }, open.id);
    const stored = await encryptMemory(open, memory);
    const friend: SpaceMember = { id: "member-friend", kind: "vault", publicKey: encodeBoxPublicKey(s.friend.publicKey), role: "write" };

    const r = await rotateSpace(open, 2, [memory], [s.creator]);
    expect(r.members.map((m) => m.id)).toEqual(["member-owner"]);
    expect(r.raw).not.toEqual(s.made.raw);
    const next = openSpaceKey(s.owner, "space12345", "member-owner", r.members[0].sealedKey);
    expect(next.epoch).toBe(2);
    const reopened = await openSpaceWithRaw("space12345", r.meta, next.raw);
    expect(reopened.name).toBe("Launch team");
    expect((await decryptMemory(reopened, r.memories[0])).body).toBe(memory.body);
    // The removed member's old key opens the old copy only, not the new one.
    await expect(decryptMemory(open, r.memories[0])).rejects.toBeInstanceOf(DecryptError);
    expect((await decryptMemory(open, stored)).title).toBe("Launch plan");
    expect(await verifyMemberTag(next.raw, "space12345", friend, await memberTag(s.made.raw, "space12345", friend))).toBe(false);
    await expect(rotateSpace(open, 3, [{ ...memory, folderId: "elsewhere" }], [s.creator])).rejects.toThrow();
  });

  it("seals space handoff notes under a key every member can derive", async () => {
    const s = await space();
    const key = await spaceHandoffKey(s.made.raw);
    const env = await sealHandoff(key, "handoff5555", cleanHandoff({ from: "Claude Code", to: "Cursor", text: CANARY }));
    expect(await openHandoff(await spaceHandoffKey(s.made.raw), "handoff5555", env)).toMatchObject({ from: "Claude Code", to: "Cursor", text: CANARY });
    await expect(createSpace("s2", "x", { ...s.creator, role: "write" })).rejects.toThrow();
  });
});
