// Proofs of a fact: made and signed on the device, the statement's hash sealed
// with the hour, completed with its proof, shared by link and checked by
// anyone against the published seals, revealing only the one claim.

import { beforeEach, describe, expect, it } from "vitest";
import { memoryFields, parseDisclosure, signPresence, vaultSigningKey, verifyDisclosure, yearsBefore } from "@sigil/core";
import { dumpDb, harness, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as disclose from "../src/vault/discloseOps";
import { createSpace } from "../src/vault/agentOps";
import { recordPresence } from "../src/server/life";
import { sealPending } from "../src/server/seal";
import { hourOf, logRead } from "../src/server/store";

const ORIGIN = "http://localhost:3000";

let h: Harness;
beforeEach(() => {
  h = harness();
});

/** Seals everything logged so far, as if the hour were over. */
const sealNow = () => sealPending(h.db, Date.now() + 2 * 3600_000);

const published = (api: ReturnType<Harness["browser"]>["api"]) => async (hours: number[]) => {
  const r = await api.post<{ roots: Record<string, string> }>("seals/roots", { hours });
  return new Map(Object.entries(r.roots).map(([k, v]) => [Number(k), v]));
};

const passport = "Name: CANARY-name Sam\nBorn: 1990-04-02\nNationality: Example\nNumber: CANARY-X1234567";

describe("a proof of one field", () => {
  it("reveals only that field, is sealed with the hour, and checks in another browser", async () => {
    const o = await signedUp(h);
    const memory = await ops.createMemory(o.b.api, o.data.folders[0], { title: "Passport", body: passport });
    const nationality = memoryFields(memory).findIndex((f) => f.name === "Nationality");
    let view = await disclose.proveField(o.b.api, o.vault, memory, nationality, { kind: "field" });
    expect(view.proof?.anchor).toBeNull();
    // Not sealed yet: it stays as it is.
    expect((await disclose.complete(o.b.api, o.vault, view)).proof?.anchor).toBeNull();
    await expect(disclose.publish(o.b.api, view)).rejects.toThrow(/not sealed yet/);

    sealNow();
    view = await disclose.complete(o.b.api, o.vault, view);
    expect(view.proof?.anchor?.kind).toBe("disclose");
    await disclose.publish(o.b.api, view);

    const visitor = h.browser();
    const res = await h.raw("GET", `proofs/${view.id}`);
    const text = await res.text();
    expect(text).toContain("Nationality");
    expect(text).not.toContain("CANARY-name");
    expect(text).not.toContain("CANARY-X1234567");
    expect(text).not.toContain("1990");
    const r = await verifyDisclosure(parseDisclosure(text), { published: published(visitor.api) });
    expect(r.ok).toBe(true);
    expect(r.claim).toBe("Nationality: Example");

    // The server never held the memory or the claim in readable form, apart from the proof the owner published.
    const db = dumpDb(h.db).replace(text.replace(/"/g, '\\"'), "");
    expect(db).not.toContain("Nationality: Example");

    // The vault keeps it, and can take the link down.
    const data = await ops.loadVault(o.b.api, o.vault);
    expect(data.disclosures[0]).toMatchObject({ id: view.id, published: true });
    await disclose.unpublish(o.b.api, view.id);
    expect((await h.raw("GET", `proofs/${view.id}`)).status).toBe(404);
    await disclose.remove(o.b.api, view.id);
    expect((await ops.loadVault(o.b.api, o.vault)).disclosures).toEqual([]);
  });

  it("keeps a birth date hidden in an age claim, and refuses a false one", async () => {
    const o = await signedUp(h);
    const memory = await ops.createMemory(o.b.api, o.data.folders[0], { title: "Passport", body: passport });
    const born = memoryFields(memory).findIndex((f) => f.name === "Born");
    const today = new Date().toISOString().slice(0, 10);
    await expect(disclose.proveField(o.b.api, o.vault, memory, born, { kind: "before", date: yearsBefore(today, 60), years: 60 })).rejects.toThrow(/would not be true/);
    let view = await disclose.proveField(o.b.api, o.vault, memory, born, { kind: "before", date: yearsBefore(today, 18), years: 18 });
    sealNow();
    view = await disclose.complete(o.b.api, o.vault, view);
    expect(JSON.stringify(view.proof)).not.toContain("1990");
    const r = await verifyDisclosure(view.proof!, { published: published(o.b.api) });
    expect(r.ok).toBe(true);
    expect(r.claim).toContain("at least 18 years");
  });

  it("is refused for publishing when it is another vault's", async () => {
    const a = await signedUp(h);
    const b = await signedUp(h);
    const m = await ops.createMemory(a.b.api, a.data.folders[0], { title: "X", body: "Colour: blue" });
    let view = await disclose.proveField(a.b.api, a.vault, m, 1, { kind: "field" });
    sealNow();
    view = await disclose.complete(a.b.api, a.vault, view);
    await expect(b.b.api.put(`disclosures/${view.id}/publish`, { proof: JSON.stringify(view.proof) })).rejects.toMatchObject({ status: 404 });
  });
});

describe("a proof of sealed history", () => {
  it("rests on the first and the latest sealed presence", async () => {
    const o = await signedUp(h);
    const key = await vaultSigningKey(o.vault.raw);
    const userId = String((h.db.prepare("SELECT user_id FROM sign_keys WHERE public_key = ?").get(key.publicKey) as { user_id: string }).user_id);
    for (const ago of [24 * 100, 24 * 50, 3]) {
      const at = new Date(Date.now() - ago * 3600_000);
      const hour = hourOf(at.getTime());
      recordPresence(h.db, userId, ORIGIN, hour, signPresence(key, ORIGIN, hour, 3600), at);
    }
    sealPending(h.db);
    let view = await disclose.proveHistory(o.b.api, o.vault);
    sealNow();
    view = await disclose.complete(o.b.api, o.vault, view);
    const r = await verifyDisclosure(view.proof!, { published: published(o.b.api) });
    expect(r.ok).toBe(true);
    expect(r.claim).toBe("At least 3 months of sealed history");
  });

  it("is refused while there is not enough history", async () => {
    const o = await signedUp(h);
    await expect(disclose.proveHistory(o.b.api, o.vault)).rejects.toThrow(/not enough sealed presence/);
  });
});

describe("a proof of membership", () => {
  it("rests on the vault's own sealed entry of joining the space", async () => {
    const o = await signedUp(h);
    const spaceId = await createSpace(o.b.api, o.data, "CANARY-space Research", "Sam");
    await expect(disclose.proveMember(o.b.api, o.vault, { id: spaceId, name: "Research" })).rejects.toThrow(/not sealed yet/);
    // Making the space wrote the join into the log. As if that was a few hours ago, sealed since:
    const row = h.db.prepare("SELECT user_id FROM read_log WHERE kind = 'space' AND memory_id = ?").get(`joined-${spaceId}`) as { user_id: string };
    h.db.prepare("DELETE FROM read_log WHERE memory_id = ?").run(`joined-${spaceId}`);
    logRead(h.db, { appId: "vault", userId: row.user_id }, "space", `joined-${spaceId}`, 1, new Date(Date.now() - 3 * 3600_000));
    sealPending(h.db);
    let view = await disclose.proveMember(o.b.api, o.vault, { id: spaceId, name: "Research" });
    sealNow();
    view = await disclose.complete(o.b.api, o.vault, view);
    const r = await verifyDisclosure(view.proof!, { published: published(o.b.api) });
    expect(r.ok).toBe(true);
    expect(r.claim).toMatch(/^Member of the team space Research since /);
  });
});
