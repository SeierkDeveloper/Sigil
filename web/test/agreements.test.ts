// Sealed agreements between two vaults: drafted by one, sealed to the other,
// reviewed and signed there, both signatures over the same hash, the hash in
// both logs and seals, amendments as new linked versions, nothing changed once
// signed, and the server never reading the text.

import { beforeEach, describe, expect, it } from "vitest";
import { formatVaultCode, isSealed, parseAgreement, verifyAgreement } from "@sigil/core";
import { dumpDb, harness, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as ag from "../src/vault/agreementOps";
import { sealPending } from "../src/server/seal";

let h: Harness;
beforeEach(() => {
  h = harness();
});

const TEXT = "CANARY-terms Sam lends Robin the camera until 1 December.";

async function two() {
  const sam = await signedUp(h);
  const robin = await signedUp(h);
  return { sam, robin, robinCode: formatVaultCode(robin.data.boxPublic!) };
}

const published = (api: ReturnType<Harness["browser"]>["api"]) => async (hours: number[]) => {
  const r = await api.post<{ roots: Record<string, string> }>("seals/roots", { hours });
  return new Map(Object.entries(r.roots).map(([k, v]) => [Number(k), v]));
};

describe("an agreement", () => {
  it("is signed by both over one hash, sealed in both logs, and checks in full", async () => {
    const { sam, robin, robinCode } = await two();
    const id = await ag.propose(sam.b.api, sam.vault, sam.data, { code: robinCode, title: "The camera", text: TEXT, me: "Sam", them: "Robin" });
    const row = h.db.prepare("SELECT offer, from_box FROM agreements WHERE id = ?").get(id) as { offer: string; from_box: string };
    expect(isSealed(row.offer)).toBe(true);
    expect(dumpDb(h.db)).not.toContain("CANARY-terms");

    let r = await ops.loadVault(robin.b.api, robin.vault);
    const waiting = r.agreements[0];
    expect(waiting).toMatchObject({ role: "to", state: "proposed", problems: [] });
    expect(waiting.doc?.text).toBe(TEXT);
    await ag.sign(robin.b.api, robin.vault, waiting);

    const s = await ops.loadVault(sam.b.api, sam.vault);
    expect(s.agreements[0]).toMatchObject({ state: "signed", problems: [] });
    r = await ops.loadVault(robin.b.api, robin.vault);
    expect(r.agreements[0].doc?.text).toBe(TEXT);

    // Both logs carry the hash; once the hour is over, both seals do.
    for (const o of [sam, robin]) {
      const e = (await ops.loadLog(o.b.api)).entries.find((x) => x.kind === "agreement" && x.memoryId === waiting.hash);
      expect(e).toMatchObject({ appId: id, count: 2 });
    }
    expect((await ag.verifiableCopy(sam.b.api, s.agreements[0])).seal).toBeNull();
    sealPending(h.db, Date.now() + 2 * 3600_000);
    for (const [o, view] of [
      [sam, s.agreements[0]],
      [robin, r.agreements[0]],
    ] as const) {
      const copy = await ag.verifiableCopy(o.b.api, view);
      const result = await verifyAgreement(parseAgreement(JSON.stringify(copy)), { published: published(h.browser().api), periodSeconds: 3600 });
      expect(result.checks.map((c) => [c.name, c.ok])).toEqual([
        ["hash", true],
        ["party-1", true],
        ["party-2", true],
        ["seal", true],
        ["published", true],
      ]);
    }
    expect(dumpDb(h.db)).not.toContain("CANARY-terms");
  });

  it("cannot be signed twice, by the sender, with another key, or changed after signing", async () => {
    const { sam, robin, robinCode } = await two();
    const id = await ag.propose(sam.b.api, sam.vault, sam.data, { code: robinCode, title: "The camera", text: TEXT, me: "Sam", them: "Robin" });
    const s = await ops.loadVault(sam.b.api, sam.vault);
    await expect(ag.sign(sam.b.api, sam.vault, s.agreements[0])).rejects.toThrow(/not waiting for your signature/);
    const box = (h.db.prepare("SELECT from_box FROM agreements WHERE id = ?").get(id) as { from_box: string }).from_box;
    await expect(sam.b.api.post(`agreements/${id}/sign`, { signature: "A".repeat(86), box })).rejects.toMatchObject({ status: 403 });
    await expect(robin.b.api.post(`agreements/${id}/sign`, { signature: "A".repeat(86), box })).rejects.toMatchObject({ code: "bad_signature" });
    const r = await ops.loadVault(robin.b.api, robin.vault);
    await ag.sign(robin.b.api, robin.vault, r.agreements[0]);
    await expect(ag.sign(robin.b.api, robin.vault, r.agreements[0])).rejects.toMatchObject({ status: 409 });
    await expect(ag.decline(sam.b.api, id)).rejects.toMatchObject({ status: 409 });
    // A stranger sees nothing of it.
    const eve = await signedUp(h);
    expect((await ops.loadVault(eve.b.api, eve.vault)).agreements).toEqual([]);
    await expect(eve.b.api.get(`agreements/${id}/seal`)).rejects.toMatchObject({ status: 404 });
  });

  it("is refused on the receiving vault when the document does not name it with its own keys", async () => {
    const { sam, robin, robinCode } = await two();
    const eve = await signedUp(h);
    // A server that hands Sam another vault's signing key for Robin.
    const lying = { ...sam.b.api, get: <T,>(path: string) => (path.startsWith("agreements/peer/") ? Promise.resolve({ signingKey: eve.data.signKey } as T) : sam.b.api.get<T>(path)) };
    await ag.propose(lying, sam.vault, sam.data, { code: robinCode, title: "x", text: "y", me: "Sam", them: "Robin" });
    const r = await ops.loadVault(robin.b.api, robin.vault);
    expect(r.agreements[0].problems).toContain("The document does not name this vault with its own keys.");
    await expect(ag.sign(robin.b.api, robin.vault, r.agreements[0])).rejects.toThrow(/does not name this vault/);
  });

  it("can be declined or withdrawn, and amended once signed, as a new version linked to the old", async () => {
    const { sam, robin, robinCode } = await two();
    const a = await ag.propose(sam.b.api, sam.vault, sam.data, { code: robinCode, title: "One", text: "First.", me: "Sam", them: "Robin" });
    await ag.decline(robin.b.api, a);
    const b = await ag.propose(sam.b.api, sam.vault, sam.data, { code: robinCode, title: "Two", text: "Second.", me: "Sam", them: "Robin" });
    await ag.decline(sam.b.api, b);
    let s = await ops.loadVault(sam.b.api, sam.vault);
    expect(Object.fromEntries(s.agreements.map((x) => [x.id, x.state]))).toEqual({ [a]: "declined", [b]: "withdrawn" });

    const c = await ag.propose(sam.b.api, sam.vault, sam.data, { code: robinCode, title: "Three", text: "Third.", me: "Sam", them: "Robin" });
    let r = await ops.loadVault(robin.b.api, robin.vault);
    await ag.sign(robin.b.api, robin.vault, r.agreements.find((x) => x.id === c)!);
    r = await ops.loadVault(robin.b.api, robin.vault);
    const signed = r.agreements.find((x) => x.id === c)!;
    // Robin amends it: a new version that names the old hash, sent to Sam.
    const d = await ag.amend(robin.b.api, robin.vault, r, signed, { title: "Three", text: "Third, amended." });
    s = await ops.loadVault(sam.b.api, sam.vault);
    const amendment = s.agreements.find((x) => x.id === d)!;
    expect(amendment).toMatchObject({ role: "to", version: 2, previous: signed.hash, problems: [] });
    expect(amendment.doc?.parties.map((p) => p.name)).toEqual(["Robin", "Sam"]);
    await ag.sign(sam.b.api, sam.vault, amendment);
    // The signed original is untouched, and cannot be amended twice.
    s = await ops.loadVault(sam.b.api, sam.vault);
    expect(s.agreements.find((x) => x.id === c)).toMatchObject({ state: "signed", hash: signed.hash });
    await expect(ag.amend(sam.b.api, sam.vault, s, s.agreements.find((x) => x.id === c)!, { title: "x", text: "y" })).rejects.toMatchObject({ status: 409 });
    // Removing hides it on one side only.
    await ag.remove(sam.b.api, a);
    expect((await ops.loadVault(sam.b.api, sam.vault)).agreements.some((x) => x.id === a)).toBe(false);
    expect((await ops.loadVault(robin.b.api, robin.vault)).agreements.some((x) => x.id === a)).toBe(true);
  });
});
