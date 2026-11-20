// Capture keys through the real router: made in the vault, used by a device
// that seals what it sends, or by a shortcut allowed to send plain text that
// the node seals on arrival; write-only, limited, logged and revoked on its own.

import { beforeEach, describe, expect, it } from "vitest";
import { captureToken, parseCaptureKey, CAPTURE_PER_MINUTE } from "@sigil/core";
import { count, dumpDb, harness, ORIGIN, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as cap from "../src/vault/captureKeyOps";
import { handleApi } from "../src/server/api";
import { resetRateLimits } from "../src/server/http";

const CANARY = "CANARY-capture-plaintext-2e";

let h: Harness;
beforeEach(() => {
  h = harness();
});

/** A phone or a watch: no cookie, only the capture key. Every body it sends is recorded. */
const device = (input: string, init: RequestInit = {}) => {
  if (typeof init.body === "string") h.sent.push(init.body);
  const url = new URL(input, ORIGIN);
  return handleApi(new Request(url, init), url.pathname.replace(/^\/api\//, "").split("/"), h.db);
};

async function withKey(plain = false) {
  const o = await signedUp(h);
  const { made } = await cap.makeCaptureKey(o.b.api, o.vault, o.data.boxPublic, "Phone shortcut", plain, ORIGIN);
  return { ...o, made };
}

describe("a capture key", () => {
  it("seals on the device and lands in the inbox, named by its key", async () => {
    const o = await withKey();
    expect(o.made.link).toBe(`${ORIGIN}/c#k=${encodeURIComponent(o.made.key)}`);
    const sent = await cap.sendWithKey(o.made.key, { title: "", body: `Remember that I parked on level 3. ${CANARY}` }, device);
    const data = await ops.loadVault(o.b.api, o.vault);
    expect(data.captureKeys).toEqual([expect.objectContaining({ id: o.made.id, name: "Phone shortcut", sent: 1, plain: false, revokedAt: null })]);
    const p = data.proposals.find((x) => x.id === sent.id)!;
    expect(p.appId).toBe(o.made.id);
    expect(p.payload).toMatchObject({ via: "capture", body: `Remember that I parked on level 3. ${CANARY}` });
    const log = await ops.loadLog(o.b.api);
    expect(log.entries.filter((e) => e.kind === "capture").map((e) => e.memoryId)).toEqual([sent.id, "key-made"]);
    // Sealed before it left the device: the node never held the text, the key or the name.
    const seen = dumpDb(h.db) + h.sent.join("\n");
    expect(seen).not.toContain(CANARY);
    expect(seen).not.toContain(o.made.key);
    expect(seen).not.toContain("Phone shortcut");
  });

  it("can only write: it reads nothing, and plain text needs the owner's yes for that key", async () => {
    const o = await withKey();
    const token = await captureToken(parseCaptureKey(o.made.key).secret);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    for (const path of ["vault", "proposals", "log", "connector/v1/folders"]) {
      expect((await h.raw("GET", path, { headers: auth })).status).toBe(401);
    }
    const plain = await h.raw("POST", "capture/v1/text", { body: { text: "parked" }, headers: auth });
    expect(plain.status).toBe(403);
    expect(await plain.json()).toMatchObject({ code: "plain_off" });
  });

  it("takes plain text from a shortcut that cannot run code, sealed by the node at once, when the owner allowed it", async () => {
    const o = await withKey(true);
    const token = await cap.tokenFor(o.made.key);
    expect(cap.plainRequest(ORIGIN, token)).toMatchObject({ url: `${ORIGIN}/api/capture/v1/text`, headers: { authorization: `Bearer ${token}` } });
    const res = await h.raw("POST", "capture/v1/text", { body: { text: `Parked on level 3 ${CANARY}`, title: "Parking" }, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    expect(res.status).toBe(201);
    const data = await ops.loadVault(o.b.api, o.vault);
    expect(data.proposals[0].payload).toMatchObject({ title: "Parking", body: `Parked on level 3 ${CANARY}` });
    // Only the sealed box is kept.
    expect(dumpDb(h.db)).not.toContain(CANARY);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM proposals WHERE sealed LIKE 's1.%'")).toBe(1);
  });

  it("is limited per minute, and stops working the moment it is revoked", async () => {
    const o = await withKey(true);
    const token = await cap.tokenFor(o.made.key);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    let limited = 0;
    for (let i = 0; i < CAPTURE_PER_MINUTE + 2; i++) {
      const r = await h.raw("POST", "capture/v1/text", { body: { text: `note ${i}` }, headers: auth });
      if (r.status === 429) limited++;
    }
    expect(limited).toBe(2);
    resetRateLimits();
    await cap.revokeCaptureKey(o.b.api, o.made.id);
    const after = await h.raw("POST", "capture/v1/text", { body: { text: "late" }, headers: auth });
    expect(after.status).toBe(401);
    await expect(cap.sendWithKey(o.made.key, { title: "", body: "late" }, device)).rejects.toThrow(/revoked/);
    const data = await ops.loadVault(o.b.api, o.vault);
    expect(data.captureKeys[0].revokedAt).not.toBeNull();
    expect((await ops.loadLog(o.b.api)).entries.some((e) => e.kind === "capture" && e.memoryId === "key-revoked")).toBe(true);
  });

  it("refuses a key made for another vault's public key", async () => {
    const a = await withKey();
    const b = await signedUp(h);
    // The node answers with another vault's key: the device catches it and seals nothing.
    const sneaky = async (input: string, init: RequestInit = {}) => {
      const res = await device(input, init);
      if (!input.endsWith("/key")) return res;
      const body = (await res.json()) as { publicKey: string; tag: string };
      return Response.json({ ...body, publicKey: b.data.boxPublic });
    };
    await expect(cap.sendWithKey(a.made.key, { title: "", body: "x" }, sneaky)).rejects.toThrow(/does not match/);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM proposals")).toBe(0);
  });
});
