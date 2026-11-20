import { describe, expect, it } from "vitest";
import {
  combineLegacyShares,
  createFolder,
  DecryptError,
  formatLegacyInvite,
  fromBase64Url,
  importKey,
  inviteTag,
  legacyCheck,
  LegacyError,
  newBoxKeyPair,
  newInviteSecret,
  newLegacyKey,
  encodeBoxPublicKey,
  openInviteIntro,
  openKept,
  openLegacyBundle,
  openLegacyNote,
  openLegacyShare,
  openOwnerRecord,
  openPassedShare,
  parseLegacyInvite,
  passShare,
  sealInviteIntro,
  sealKept,
  sealLegacyPlan,
  splitLegacyKey,
  verifyInviteTag,
  DEFAULT_RULES,
  type BoxKeyPair,
  type LegacyPersonPlan,
} from "../src/index";

const CANARY = "CANARY-legacy-model-key-77";

function person(label: string, pair: BoxKeyPair | null, folderIds: string[], self = false): LegacyPersonPlan {
  return { id: `trustee-${label.toLowerCase()}`, label, publicKey: pair ? encodeBoxPublicKey(pair.publicKey) : null, invite: null, folderIds, self };
}

async function setup() {
  const vaultKey = await importKey(new Uint8Array(32).fill(7));
  const family = await createFolder(vaultKey, "Family");
  const work = await createFolder(vaultKey, "Work");
  const a = newBoxKeyPair();
  const b = newBoxKeyPair();
  const c = newBoxKeyPair();
  return { vaultKey, family: family.folder, work: work.folder, a, b, c };
}

describe("Shamir split and combine", () => {
  it("gives the key back from any k of n shares and not from fewer", async () => {
    const key = newLegacyKey();
    const check = legacyCheck(key, "plan1", 1);
    const shares = await splitLegacyKey(key, 5, 3);
    expect(shares).toHaveLength(5);
    for (const pick of [
      [0, 1, 2],
      [1, 3, 4],
      [4, 2, 0],
      [0, 1, 2, 3, 4],
    ]) {
      const back = await combineLegacyShares(
        pick.map((i) => shares[i]),
        3,
        { planId: "plan1", epoch: 1, check },
      );
      expect(back).toEqual(key);
    }
    await expect(combineLegacyShares([shares[0], shares[1]], 3, { planId: "plan1", epoch: 1, check })).rejects.toMatchObject({ code: "too_few" });
  });

  it("does not count the same share twice", async () => {
    const key = newLegacyKey();
    const shares = await splitLegacyKey(key, 3, 2);
    await expect(combineLegacyShares([shares[0], shares[0].slice()], 2, { planId: "p", epoch: 1, check: legacyCheck(key, "p", 1) })).rejects.toBeInstanceOf(LegacyError);
  });

  it("refuses shares from another epoch or another key", async () => {
    const key = newLegacyKey();
    const other = newLegacyKey();
    const a = await splitLegacyKey(key, 3, 2);
    const b = await splitLegacyKey(other, 3, 2);
    await expect(combineLegacyShares([a[0], b[1]], 2, { planId: "p", epoch: 1, check: legacyCheck(key, "p", 1) })).rejects.toMatchObject({ code: "mismatch" });
    await expect(combineLegacyShares([a[0], a[1]], 2, { planId: "p", epoch: 2, check: legacyCheck(key, "p", 1) })).rejects.toMatchObject({ code: "mismatch" });
  });

  it("uses fresh randomness for every split, so a share is never the key", async () => {
    const key = new Uint8Array(32).fill(1);
    const s1 = await splitLegacyKey(key, 2, 2);
    const s2 = await splitLegacyKey(key, 2, 2);
    expect(s1[0]).not.toEqual(s2[0]);
    expect(s1[0].slice(0, 32)).not.toEqual(key);
  });

  it("with k = 1 each share is the key, and bad sizes are refused", async () => {
    const key = newLegacyKey();
    const shares = await splitLegacyKey(key, 2, 1);
    expect(shares[0]).toEqual(key);
    expect(await combineLegacyShares([shares[1]], 1, { planId: "p", epoch: 1, check: legacyCheck(key, "p", 1) })).toEqual(key);
    await expect(splitLegacyKey(key, 3, 4)).rejects.toThrow();
    await expect(splitLegacyKey(key, 0, 1)).rejects.toThrow();
    await expect(splitLegacyKey(key, 13, 2)).rejects.toThrow();
    await expect(splitLegacyKey(new Uint8Array(16), 2, 2)).rejects.toThrow();
  });
});

describe("sealing a plan", () => {
  it("seals each share and bundle to one person, and only k people together with that person's vault open a bundle", async () => {
    const s = await setup();
    const people = [person("Ana", s.a, [s.family.id], true), person("Ben", s.b, [s.work.id]), person("Cy", s.c, [s.family.id, s.work.id])];
    const plan = await sealLegacyPlan(s.vaultKey, {
      planId: "plan1",
      epoch: 1,
      owner: "Sam",
      periodDays: 180,
      threshold: 2,
      includeModel: true,
      people,
      folders: [s.family, s.work],
      rules: { ...DEFAULT_RULES, name: "Sam's AI self", denyTopics: ["money"] },
      model: { provider: "anthropic", model: "claude-opus-5-5", apiKey: CANARY },
      ownerKey: encodeBoxPublicKey(newBoxKeyPair().publicKey),
    });
    expect(plan.people.map((p) => !!p.share)).toEqual([true, true, true]);
    for (const p of plan.people) expect(p.share! + p.bundle! + p.note!).not.toContain(CANARY);

    const ref = (i: number) => ({ planId: "plan1", epoch: 1, trusteeId: plan.people[i].id });
    // Ana opens her own share, not Ben's.
    const ana = openLegacyShare(s.a, { ...ref(0), sealed: plan.people[0].share! });
    expect(() => openLegacyShare(s.a, { ...ref(1), sealed: plan.people[1].share! })).toThrow(DecryptError);
    expect(ana.payload.threshold).toBe(2);
    expect(ana.payload.trustees.map((t) => t.label)).toEqual(["Ana", "Ben", "Cy"]);

    // Ben passes his share to Ana, sealed to the key in Ana's own copy of the plan.
    const ben = openLegacyShare(s.b, { ...ref(1), sealed: plan.people[1].share! });
    const passed = passShare(ben.payload, ben.share, ana.payload.trusteeId);
    expect(() => openPassedShare(s.c, ana.payload, ben.payload.trusteeId, passed)).toThrow(DecryptError);
    const fromBen = openPassedShare(s.a, ana.payload, ben.payload.trusteeId, passed);

    const key = await combineLegacyShares([ana.share, fromBen], 2, { planId: "plan1", epoch: 1, check: ana.payload.check });
    const bundle = await openLegacyBundle(key, s.a, { ...ref(0), sealed: plan.people[0].bundle! });
    expect(bundle.folders).toEqual([{ id: s.family.id, key: expect.any(String) }]);
    expect(fromBase64Url(bundle.folders[0].key)).toEqual(s.family.raw);
    expect(bundle.self?.rules.folderIds).toEqual([s.family.id]);
    expect(bundle.self?.rules.denyTopics).toEqual(["money"]);
    expect(bundle.self?.model?.apiKey).toBe(CANARY);
    expect(bundle.owner).toBe("Sam");

    // With the key, Ana still cannot open Cy's bundle: it is sealed to Cy's vault as well.
    await expect(openLegacyBundle(key, s.a, { ...ref(2), sealed: plan.people[2].bundle! })).rejects.toBeInstanceOf(DecryptError);
    // And Cy cannot open hers without the key.
    await expect(openLegacyBundle(newLegacyKey(), s.c, { ...ref(2), sealed: plan.people[2].bundle! })).rejects.toBeInstanceOf(DecryptError);
    const cy = await openLegacyBundle(key, s.c, { ...ref(2), sealed: plan.people[2].bundle! });
    expect(cy.folders.map((f) => f.id)).toEqual([s.family.id, s.work.id]);
    expect(cy.self).toBeNull();

    // Each note tells the person what they would get, readable before any release.
    const note = openLegacyNote(s.b, { ...ref(1), sealed: plan.people[1].note! });
    expect(note).toMatchObject({ owner: "Sam", label: "Ben", folders: ["Work"], self: false, periodDays: 180, threshold: 2, total: 3 });
    expect(plan.complete).toBe(true);
  });

  it("keeps the owner's record under the vault key, and a new epoch makes old shares useless", async () => {
    const s = await setup();
    const input = {
      planId: "plan2",
      owner: "Sam",
      periodDays: 90,
      threshold: 2,
      includeModel: false,
      people: [person("Ana", s.a, [s.family.id]), person("Ben", s.b, [s.family.id])],
      folders: [s.family, s.work],
      rules: null,
      model: null,
      ownerKey: null,
    };
    const one = await sealLegacyPlan(s.vaultKey, { ...input, epoch: 1 });
    const two = await sealLegacyPlan(s.vaultKey, { ...input, epoch: 2 });
    const record = await openOwnerRecord(s.vaultKey, "plan2", two.ownerBox);
    expect(record).toMatchObject({ epoch: 2, owner: "Sam", periodDays: 90, threshold: 2 });
    expect(record.people.map((p) => p.label)).toEqual(["Ana", "Ben"]);
    await expect(openOwnerRecord(await importKey(new Uint8Array(32).fill(8)), "plan2", two.ownerBox)).rejects.toBeInstanceOf(DecryptError);

    const oldAna = openLegacyShare(s.a, { planId: "plan2", epoch: 1, trusteeId: one.people[0].id, sealed: one.people[0].share! });
    const newBen = openLegacyShare(s.b, { planId: "plan2", epoch: 2, trusteeId: two.people[1].id, sealed: two.people[1].share! });
    await expect(combineLegacyShares([oldAna.share, newBen.share], 2, { planId: "plan2", epoch: 2, check: two.check })).rejects.toMatchObject({ code: "mismatch" });
    // A share sealed for epoch 1 does not open as epoch 2.
    expect(() => openLegacyShare(s.a, { planId: "plan2", epoch: 2, trusteeId: one.people[0].id, sealed: one.people[0].share! })).toThrow(DecryptError);
  });

  it("refuses plans that cannot work", async () => {
    const s = await setup();
    const base = { planId: "p", epoch: 1, owner: "Sam", periodDays: 180, includeModel: false, folders: [s.family], rules: null, model: null, ownerKey: null };
    await expect(sealLegacyPlan(s.vaultKey, { ...base, threshold: 1, people: [] })).rejects.toThrow("at least one trusted person");
    await expect(sealLegacyPlan(s.vaultKey, { ...base, threshold: 3, people: [person("Ana", s.a, [s.family.id]), person("Ben", s.b, [s.family.id])] })).rejects.toThrow("between 1 and 2");
    await expect(sealLegacyPlan(s.vaultKey, { ...base, threshold: 1, people: [person("Ana", s.a, [])] })).rejects.toThrow("at least one folder");
    await expect(sealLegacyPlan(s.vaultKey, { ...base, threshold: 1, people: [person("Ana", s.a, ["gone-folder-id"])] })).rejects.toThrow("no longer exists");
    await expect(sealLegacyPlan(s.vaultKey, { ...base, periodDays: 5, threshold: 1, people: [person("Ana", s.a, [s.family.id])] })).rejects.toThrow("period");
  });

  it("leaves a person waiting on an invite without a share until the owner seals again", async () => {
    const s = await setup();
    const base = { planId: "p3", epoch: 1, owner: "Sam", periodDays: 365, includeModel: false, folders: [s.family], rules: null, model: null, ownerKey: null };
    const people = [person("Ana", s.a, [s.family.id]), person("Dee", null, [s.family.id])];
    const plan = await sealLegacyPlan(s.vaultKey, { ...base, threshold: 1, people });
    expect(plan.complete).toBe(true);
    expect(plan.people[1]).toMatchObject({ publicKey: null, share: null, bundle: null, note: null });
    // With two needed and one key known, the plan waits: no shares at all, but Ana is told she is named.
    const waiting = await sealLegacyPlan(s.vaultKey, { ...base, threshold: 2, people });
    expect(waiting.complete).toBe(false);
    expect(waiting.people.map((p) => [!!p.share, !!p.bundle, !!p.note])).toEqual([
      [false, false, true],
      [false, false, false],
    ]);
    expect(openLegacyNote(s.a, { planId: "p3", epoch: 1, trusteeId: people[0].id, sealed: waiting.people[0].note! })).toMatchObject({ threshold: 2, total: 2 });
  });
});

describe("invites", () => {
  it("round trips the link, and the tag binds the invited vault's key to the secret only the link holds", async () => {
    const secret = newInviteSecret();
    const link = formatLegacyInvite("https://example.org/", "trustee12345", secret);
    expect(link.startsWith("https://example.org/vault/legacy#invite=trustee12345.")).toBe(true);
    const parsed = parseLegacyInvite(new URL(link).hash);
    expect(parsed.trusteeId).toBe("trustee12345");
    expect(parsed.secret).toEqual(secret);
    expect(() => parseLegacyInvite("#invite=x")).toThrow("incomplete");

    const key = encodeBoxPublicKey(newBoxKeyPair().publicKey);
    const other = encodeBoxPublicKey(newBoxKeyPair().publicKey);
    const tag = await inviteTag(secret, "trustee12345", key);
    expect(await verifyInviteTag(secret, "trustee12345", key, tag)).toBe(true);
    expect(await verifyInviteTag(secret, "trustee12345", other, tag)).toBe(false);
    expect(await verifyInviteTag(newInviteSecret(), "trustee12345", key, tag)).toBe(false);
    expect(await verifyInviteTag(secret, "trustee99999", key, tag)).toBe(false);

    const intro = await sealInviteIntro(secret, "trustee12345", { owner: "Sam", label: "Ana" });
    expect(await openInviteIntro(secret, "trustee12345", intro)).toEqual({ owner: "Sam", label: "Ana" });
    await expect(openInviteIntro(newInviteSecret(), "trustee12345", intro)).rejects.toBeInstanceOf(DecryptError);
  });
});

describe("what a trusted person keeps", () => {
  it("is kept under their own vault key", async () => {
    const mine = await importKey(new Uint8Array(32).fill(3));
    const kept = {
      v: 1 as const,
      planId: "p9",
      epoch: 4,
      bundle: { v: 1 as const, planId: "p9", epoch: 4, trusteeId: "t1234567", owner: "Sam", ownerKey: null, folders: [{ id: "folder123", key: "A".repeat(43) }], self: null },
    };
    const env = await sealKept(mine, kept);
    expect(await openKept(mine, "p9", env)).toMatchObject({ planId: "p9", epoch: 4, bundle: { owner: "Sam", folders: [{ id: "folder123" }] } });
    await expect(openKept(mine, "p8", env)).rejects.toBeInstanceOf(DecryptError);
  });
});
