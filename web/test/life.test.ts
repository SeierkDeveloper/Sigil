// Proof of a real life: signed presence while the vault is open, sealed with
// the hour, and a certificate built on the device that anyone can check
// against the published seals without seeing anything in the vault.

import { beforeEach, describe, expect, it } from "vitest";
import { parseCertificate, signPresence, vaultSigningKey, verifyCertificate } from "@sigil/core";
import { count, dumpDb, harness, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as life from "../src/vault/lifeOps";
import { recordPresence } from "../src/server/life";
import { sealPending } from "../src/server/seal";
import { hourOf } from "../src/server/store";

const ORIGIN = "http://localhost:3000";
const CANARY = "CANARY-life-plaintext-07";

let h: Harness;
beforeEach(() => {
  h = harness();
});

function userIdOf(publicKey: string): string {
  return String((h.db.prepare("SELECT user_id FROM sign_keys WHERE public_key = ?").get(publicKey) as { user_id: string }).user_id);
}

/** Presence at past hours, as if the vault had been open then, sealed once those hours were over. */
async function history(owner: Awaited<ReturnType<typeof signedUp>>, hoursAgo: number[]) {
  const key = await vaultSigningKey(owner.vault.raw);
  const userId = userIdOf(key.publicKey);
  for (const ago of hoursAgo) {
    const at = new Date(Date.now() - ago * 3600_000);
    const hour = hourOf(at.getTime());
    recordPresence(h.db, userId, ORIGIN, hour, signPresence(key, ORIGIN, hour, 3600), at);
  }
  sealPending(h.db);
  return key;
}

const published = (api: ReturnType<Harness["browser"]>["api"]) => async (hours: number[]) => {
  const r = await api.post<{ roots: Record<string, string> }>("seals/roots", { hours });
  return new Map(Object.entries(r.roots).map(([k, v]) => [Number(k), v]));
};

describe("presence", () => {
  it("registers the vault's signing key and records one signed presence per period", async () => {
    const owner = await signedUp(h);
    expect(owner.data.signKey).toBe((await vaultSigningKey(owner.vault.raw)).publicKey);
    expect(await life.sendPresence(owner.b.api, owner.vault)).toMatchObject({ recorded: true, periodSeconds: 3600 });
    expect(await life.sendPresence(owner.b.api, owner.vault)).toMatchObject({ recorded: false });
    expect(count(h.db, "SELECT COUNT(*) AS n FROM read_log WHERE kind = 'presence'")).toBe(1);
    // Presence is kept out of the read log the vault shows; the Proof tab counts it.
    const data = await ops.loadVault(owner.b.api, owner.vault);
    expect(data.presence).toMatchObject({ total: 1, sealed: 0 });
  });

  it("refuses a signature from another key, for another hour, or a signing key that changes", async () => {
    const owner = await signedUp(h);
    const t = await owner.b.api.get<{ hour: number; origin: string }>("presence");
    const other = await vaultSigningKey(new Uint8Array(32).fill(9));
    await expect(owner.b.api.post("presence", { hour: t.hour, sig: signPresence(other, t.origin, t.hour, 3600) })).rejects.toMatchObject({ code: "bad_signature" });
    const mine = await vaultSigningKey(owner.vault.raw);
    await expect(owner.b.api.post("presence", { hour: t.hour - 1, sig: signPresence(mine, t.origin, t.hour - 1, 3600) })).rejects.toMatchObject({ code: "stale" });
    await expect(owner.b.api.post("vault/sign-key", { publicKey: other.publicKey })).rejects.toMatchObject({ code: "sign_exists" });
  });
});

describe("a life certificate", () => {
  it("is built on the device from sealed presence, and checks out against the published seals", async () => {
    const owner = await signedUp(h);
    await ops.createMemory(owner.b.api, owner.data.folders[0], { title: "Private", body: CANARY });
    await history(owner, [24 * 40, 24 * 20, 24 * 3, 5, 4, 2]);
    const cert = await life.makeCertificate(owner.b.api, owner.vault);
    expect(cert.body.hours).toHaveLength(6);
    expect(cert.body.summary).toMatchObject({ activeHours: 6, activeDays: expect.any(Number), continuousMonths: 1 });
    expect(JSON.stringify(cert)).not.toContain(CANARY);
    // A visitor's browser: no session, only the public roots.
    const visitor = h.browser();
    const r = await verifyCertificate(parseCertificate(JSON.stringify(cert)), { published: published(visitor.api) });
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual(["signature", "presence", "proofs", "summary", "published"]);
  });

  it("is published by link, read by anyone with it, and taken down by its owner", async () => {
    const owner = await signedUp(h);
    await history(owner, [30, 10]);
    const cert = await life.makeCertificate(owner.b.api, owner.vault);
    const id = await life.publishCertificate(owner.b.api, cert);
    expect(life.certificateLink(ORIGIN, id)).toBe(`${ORIGIN}/verify?certificate=${id}`);
    const visitor = h.browser();
    const text = await (await h.raw("GET", `certificates/${id}`)).text();
    expect((await verifyCertificate(parseCertificate(text), { published: published(visitor.api) })).ok).toBe(true);
    expect((await ops.loadVault(owner.b.api, owner.vault)).certificates.map((c) => c.id)).toEqual([id]);

    // Someone else's certificate cannot be published from this vault.
    const other = await signedUp(h);
    await expect(life.publishCertificate(other.b.api, cert)).rejects.toMatchObject({ status: 400 });
    await expect(life.unpublishCertificate(other.b.api, id)).rejects.toMatchObject({ status: 404 });
    await life.unpublishCertificate(owner.b.api, id);
    expect((await h.raw("GET", `certificates/${id}`)).status).toBe(404);
  });

  it("fails against the published seals once a root is not the one the site sealed", async () => {
    const owner = await signedUp(h);
    await history(owner, [8, 6]);
    const cert = await life.makeCertificate(owner.b.api, owner.vault);
    const hour = cert.body.hours[0].hour;
    h.db.prepare("UPDATE seals SET root = ? WHERE hour = ?").run("0x" + "11".repeat(32), hour);
    const r = await verifyCertificate(cert, { published: published(h.browser().api) });
    expect(r.checks.find((c) => c.name === "published")).toMatchObject({ ok: false });
    expect(dumpDb(h.db)).not.toContain(CANARY);
  });

  it("says plainly when there is nothing sealed yet", async () => {
    const owner = await signedUp(h);
    await expect(life.makeCertificate(owner.b.api, owner.vault)).rejects.toThrow("no sealed presence");
  });
});
