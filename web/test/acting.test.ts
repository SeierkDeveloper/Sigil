// A self that acts: limits kept encrypted, receipts signed on the device and
// sealed with the hour like read-log entries, replies approved within limits,
// payments past a limit waiting in Work, and the database migration that lets
// a payment wait there. No chain is reached: the wallet itself is tested with
// Foundry and end to end on a local chain.

import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkReceipt, selfIdentityKey, type PaymentChannel } from "@sigil/core";
import { count, dumpDb, harness, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as limits from "../src/vault/limitsOps";
import * as receipts from "../src/vault/receiptOps";
import * as work from "../src/vault/workOps";
import { sealPending, getSeal } from "../src/server/seal";
import { openDb } from "../src/server/db";

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("limits for acting", () => {
  it("are kept encrypted under the vault key and opened on the device", async () => {
    const o = await signedUp(h);
    expect(o.data.limits.payments.on).toBe(false);
    await limits.saveLimits(o.b.api, o.vault, { ...o.data.limits, replies: { on: true, contacts: ["CANARY-contact@example.org"] }, meetings: { ...o.data.limits.meetings, on: true, timeZone: "Europe/Paris" } });
    const data = await ops.loadVault(o.b.api, o.vault);
    expect(data.limits.replies).toEqual({ on: true, contacts: ["canary-contact@example.org"] });
    expect(data.limits.meetings.timeZone).toBe("Europe/Paris");
    expect(dumpDb(h.db).toLowerCase()).not.toContain("canary-contact");
  });
});

describe("receipts", () => {
  it("are signed by the self key on the device, kept as ciphertext, and sealed with the hour like a read", async () => {
    const o = await signedUp(h);
    const r = await receipts.recordReceipt(o.b.api, o.vault, { kind: "payment", what: "Paid 0.01 to CANARY-friend", limit: "Payments to listed recipients", ref: { chainId: "31337", tx: "0xabc" } }, "http://localhost:3000");
    expect(r.receipt?.body.selfKey).toBe((await selfIdentityKey(o.vault.raw)).address);
    // The server keeps the fingerprint and an envelope, never the receipt.
    expect(dumpDb(h.db)).not.toContain("CANARY-friend");
    expect(count(h.db, "SELECT COUNT(*) AS n FROM read_log WHERE kind = 'identity' AND memory_id = 'receipt'")).toBe(1);
    let list = await receipts.loadReceipts(o.b.api, o.vault);
    expect(list).toHaveLength(1);
    expect(list[0].sealed).toBe(false);
    expect(list[0].receipt?.body.what).toBe("Paid 0.01 to CANARY-friend");

    // Once the hour is over, its fingerprint is in the seal, next to the reads.
    const made = sealPending(h.db, Date.now() + 2 * 3600_000);
    expect(made.length).toBeGreaterThan(0);
    list = await receipts.loadReceipts(o.b.api, o.vault);
    const shared = list[0].shared!;
    expect(list[0].sealed).toBe(true);
    expect(shared.seal?.root).toBe(getSeal(h.db, shared.seal!.hour)!.root);
    expect(checkReceipt(shared).ok).toBe(true);
    // Anyone with the fingerprint gets its proof from the public route, as for a read.
    const proof = await h.raw("GET", `seals/${shared.seal!.hour}/proof?leaf=${list[0].leaf}`);
    expect(proof.status).toBe(200);
    // A changed receipt no longer checks.
    expect(checkReceipt({ ...shared, receipt: { ...shared.receipt, body: { ...shared.receipt.body, what: "Paid 100" } } }).ok).toBe(false);
  });

  it("belong to their vault only, and a fingerprint is kept once", async () => {
    const a = await signedUp(h);
    const b = await signedUp(h);
    const r = await receipts.recordReceipt(a.b.api, a.vault, { kind: "approval", what: "Approved a reply", limit: "Replies to listed contacts" });
    expect(await receipts.loadReceipts(b.b.api, b.vault)).toEqual([]);
    await expect(receipts.deleteReceipt(b.b.api, r.id)).rejects.toMatchObject({ status: 404 });
    await expect(a.b.api.post("self/receipts", { id: "receipt-again-1", leaf: r.leaf, box: r.shared ? (await a.b.api.get<{ receipts: { box: string }[] }>("self/receipts")).receipts[0].box : "" })).rejects.toMatchObject({ status: 409 });
    expect((await h.raw("GET", "self/receipts")).status).toBe(401);
    await receipts.deleteReceipt(a.b.api, r.id);
    expect(await receipts.loadReceipts(a.b.api, a.vault)).toEqual([]);
  });
});

describe("the approval queue with limits", () => {
  it("approves a reply to a listed contact on its own, with a receipt, and holds anyone else's", async () => {
    const o = await signedUp(h);
    await limits.saveLimits(o.b.api, o.vault, { ...o.data.limits, replies: { on: true, contacts: ["sam@example.org"] } });
    const data = await ops.loadVault(o.b.api, o.vault);
    const within = await work.draftReply(o.b.api, o.vault, data, { message: "Subject: Lunch\n\nAre you free on Friday?", from: "Sam <sam@example.org>" }, { model: null });
    expect(within.state).toBe("approved");
    expect(within.record?.auto).toMatchObject({ limit: "Replies to listed contacts (sam@example.org)" });
    const held = await work.draftReply(o.b.api, o.vault, data, { message: "Subject: Offer\n\nBuy now", from: "Someone <someone@example.org>" }, { model: null });
    expect(held.state).toBe("waiting");
    const list = await receipts.loadReceipts(o.b.api, o.vault);
    expect(list.map((r) => r.receipt?.body.kind)).toEqual(["approval"]);
    expect(list[0].id).toBe(within.record?.auto?.receiptId);
    expect(list[0].receipt?.body.what).toContain("ready to send");
  });

  it("keeps a payment past the limits waiting, and approving it signs a receipt after the owner's wallet paid", async () => {
    const o = await signedUp(h);
    const channel: PaymentChannel = { kind: "payment", chainId: "31337", wallet: "0x00000000000000000000000000000000005e1f02", target: "0x1111111111111111111111111111111111111111", value: "10", data: "0x", to: "A friend", amount: "0.00000000000000001", token: null };
    const view = await work.saveDraft(o.b.api, o.vault, null, { ...(await import("@sigil/core")).newDraft({ kind: "payment", title: "Pay A friend", input: "Over the most per payment you set here.", channel, draft: "Paid to A friend." }) });
    expect(view.state).toBe("waiting");
    const data = await ops.loadVault(o.b.api, o.vault);
    expect(data.drafts[0].record?.channel).toEqual(channel);
    await expect(work.approve(o.b.api, o.vault, data, data.drafts[0], "x", { model: null, settings: data.work })).rejects.toThrow(/cannot be sent from here/);
    const paid: PaymentChannel[] = [];
    const out = await work.approve(o.b.api, o.vault, data, data.drafts[0], "x", { model: null, settings: data.work, pay: async (ch) => (paid.push(ch), { tx: "0xfeed" }) });
    expect(paid).toEqual([channel]);
    expect(out.draft.state).toBe("approved");
    const r = await receipts.loadReceipts(o.b.api, o.vault);
    expect(r[0].receipt?.body).toMatchObject({ kind: "payment", limit: "Approved by you in Work", ref: { tx: "0xfeed", chainId: "31337" } });
  });
});

describe("the drafts table", () => {
  it("is rebuilt so a payment may wait, keeping every row of an older node", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "sigil-drafts-")), "old.db");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE drafts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('reply', 'plan', 'answer')), ref TEXT, box TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('waiting', 'approved', 'discarded')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (user_id, ref));`);
    old.exec("INSERT INTO users (id) VALUES ('u1'); INSERT INTO drafts VALUES ('d1', 'u1', 'reply', NULL, 'box', 'waiting', 't', 't');");
    old.close();
    const db = openDb(file);
    expect(count(db, "SELECT COUNT(*) AS n FROM drafts WHERE id = 'd1'")).toBe(1);
    db.prepare("INSERT INTO drafts VALUES ('d2', 'u1', 'payment', NULL, 'box', 'waiting', 't', 't')").run();
    expect(count(db, "SELECT COUNT(*) AS n FROM drafts")).toBe(2);
  });
});
