// The fixes of the round-eight security review, each with the attack it stops.
// See docs/SECURITY-REVIEW.md for every finding.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appKeys,
  encryptJson,
  newRecoveryPhrase,
  parseAppKey,
  phraseKeys,
  randomId,
  sealBundle,
  vaultSigningKey,
  wrapVaultKey,
  type BundleBody,
} from "@sigil/core";
import { count, harness, readerFor, signedUp, wallet, ORIGIN, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as storage from "../src/vault/storageOps";
import * as agents from "../src/vault/agentOps";
import * as guard from "../src/vault/protectOps";
import { clientIp, rateLimit, readJson, resetRateLimits } from "../src/server/http";
import { hostAllowed, isPrivateAddress } from "../src/server/netguard";
import { remoteOrigin } from "../src/server/nodes";
import { HttpError } from "../src/server/store";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  delete process.env.SIGIL_PROXY_HOPS;
  delete process.env.SIGIL_NODE_ALLOW_PRIVATE;
});

const userIdOf = (db: Harness["db"], boxPublic: string) => String((db.prepare("SELECT user_id FROM box_keys WHERE public_key = ?").get(boxPublic) as { user_id: string }).user_id);

describe("restoring a bundle", () => {
  it("never hangs rows off another vault's space or account, even in a bundle signed by its own key", async () => {
    // The victim's vault and shared memory live on this node.
    const victim = await signedUp(h);
    const spaceId = await agents.createSpace(victim.b.api, victim.data, "Family", "Sam");
    const victimId = userIdOf(h.db, victim.data.boxPublic!);

    // The attacker makes a vault on another node, takes its bundle, and adds rows that point at the victim.
    const elsewhere = harness("https://elsewhere.example");
    const attacker = await signedUp(elsewhere);
    const made = await storage.makeBundle(attacker.b.api, attacker.vault);
    const body: BundleBody = structuredClone(made.body);
    const spaces = body.parts.spaces as unknown as { table: string; row: Record<string, unknown> }[];
    spaces.push({
      table: "space_members",
      row: { id: randomId(), space_id: spaceId, kind: "vault", user_id: "@vault", role: "admin", public_key: attacker.data.boxPublic, sealed_key: "s1.x", tag: "00".repeat(32), label: "v1.x", accepted_at: new Date().toISOString(), created_at: new Date().toISOString() },
    });
    const apps = body.parts.apps as unknown as { table: string; row: Record<string, unknown> }[];
    apps.push({ table: "apps", row: { id: randomId(), user_id: victimId, meta: "v1.x", secret: "v1.x", token_hash: "ab".repeat(32), created_at: new Date().toISOString() } });
    const bundle = sealBundle(body, await vaultSigningKey(attacker.vault.raw));
    const opened = await storage.openForRestore(bundle, { kind: "phrase", phrase: attacker.phrase });
    const restored = await storage.restoreHere(h.browser().api, opened, bundle, ORIGIN);

    expect(restored.report.left.space_members).toBe(1);
    expect(restored.report.left.apps).toBe(1);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM space_members WHERE space_id = ?", spaceId)).toBe(1);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM apps WHERE user_id = ?", victimId)).toBe(0);
  });
});

describe("sessions", () => {
  it("end when the sign-in method that opened them is removed or replaced", async () => {
    const owner = await signedUp(h);
    // A second wallet, signed in on another browser.
    const second = await wallet();
    const wk = await (await import("@sigil/core")).walletKeys(second.address, second.signature);
    await owner.b.api.post("keyslots/wallet", { address: second.address, authToken: wk.authToken, wrappedKey: await wrapVaultKey(wk.kek, owner.vault.raw, "wallet") });
    const other = h.browser();
    await other.api.post("auth/wallet/login", { address: second.address, authToken: wk.authToken });
    expect((await other.api.get<{ signedIn: boolean }>("session")).signedIn).toBe(true);
    const slots = await owner.b.api.get<{ keyslots: { id: string; kind: string; label: string | null }[] }>("keyslots");
    const slot = slots.keyslots.find((k) => k.kind === "wallet" && k.label === second.address.toLowerCase())!;
    await owner.b.api.del(`keyslots/${slot.id}`);
    expect((await other.api.get<{ signedIn: boolean }>("session")).signedIn).toBe(false);

    // A browser signed in with the recovery phrase loses its session when the phrase is replaced.
    const pk = await phraseKeys(owner.phrase);
    const byPhrase = h.browser();
    await byPhrase.api.post("auth/phrase/login", { lookupId: pk.lookupId, authToken: pk.authToken });
    expect((await byPhrase.api.get<{ signedIn: boolean }>("session")).signedIn).toBe(true);
    const fresh = await phraseKeys(newRecoveryPhrase());
    await owner.b.api.post("keyslots/phrase", { lookupId: fresh.lookupId, authToken: fresh.authToken, wrappedKey: await wrapVaultKey(fresh.kek, owner.vault.raw, "phrase") });
    expect((await byPhrase.api.get<{ signedIn: boolean }>("session")).signedIn).toBe(false);
    // The owner's own session stays.
    expect((await owner.b.api.get<{ signedIn: boolean }>("session")).signedIn).toBe(true);
  });

  it("refuse requests another site makes with the cookie, reads included", async () => {
    const { b } = await signedUp(h);
    const cookie = `sigil_session=${b.cookie()}`;
    const cross = await h.raw("GET", "self/pending", { headers: { cookie, "sec-fetch-site": "cross-site" } });
    expect(cross.status).toBe(403);
    expect((await h.raw("GET", "vault", { headers: { cookie, "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await h.raw("GET", "self/pending", { headers: { cookie, "sec-fetch-site": "same-origin" } })).status).toBe(200);
    // A request typed into the address bar says "none" and is fine.
    expect((await h.raw("GET", "self/pending", { headers: { cookie, "sec-fetch-site": "none" } })).status).toBe(200);
  });
});

describe("request bodies", () => {
  it("are never read past their limit, with or without a declared length", async () => {
    const big = "x".repeat(64 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 64; i++) c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const req = new Request("http://localhost/api/x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(readJson(req, 1024 * 1024)).rejects.toMatchObject({ status: 413 });
    await expect(readJson(new Request("http://localhost/", { method: "POST", headers: { "content-length": "999999999" }, body: "{}" }), 1024)).rejects.toMatchObject({ status: 413 });
    await expect(readJson(new Request("http://localhost/", { method: "POST", body: new Uint8Array([0xff, 0xfe, 0x7b]) }), 1024)).rejects.toMatchObject({ status: 400 });
    expect(await readJson(new Request("http://localhost/", { method: "POST", body: '{"a":1}' }), 1024)).toEqual({ a: 1 });
  });
});

describe("rate limits", () => {
  it("count the address the nearest proxy saw, not one the caller wrote", () => {
    const req = (xff: string) => new Request("http://localhost/", { headers: { "x-forwarded-for": xff } });
    expect(clientIp(req("1.1.1.1, 203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIp(req("203.0.113.9"))).toBe("203.0.113.9");
    process.env.SIGIL_PROXY_HOPS = "2";
    expect(clientIp(req("1.1.1.1, 203.0.113.9, 10.0.0.2"))).toBe("203.0.113.9");
    process.env.SIGIL_PROXY_HOPS = "0";
    expect(clientIp(req("203.0.113.9"))).toBe("local");
    delete process.env.SIGIL_PROXY_HOPS;
    // Writing a new first address each time does not get around a limit.
    resetRateLimits();
    let refused = 0;
    for (let i = 0; i < 12; i++) {
      try {
        rateLimit(`ask:${clientIp(req(`198.51.100.${i}, 203.0.113.50`))}`, 8, 60_000);
      } catch (err) {
        if (err instanceof HttpError && err.status === 429) refused++;
      }
    }
    expect(refused).toBe(4);
  });
});

describe("addresses this node fetches", () => {
  it("refuse every private form of an address, and private names", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "0.0.0.0", "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "fd00::1", "fe80::1", "2002:7f00:1::", "224.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "2606:4700::1111", "::ffff:93.184.216.34"]) expect(isPrivateAddress(ip), ip).toBe(false);
    for (const host of ["localhost", "db.internal", "printer.local", "intranet", "[::ffff:7f00:1]", "[::1]"]) expect(hostAllowed(host), host).toBe(false);
    expect(hostAllowed("node.example.org")).toBe(true);
    // Through the move and restore checks, which run before anything is fetched.
    for (const origin of ["https://[::ffff:7f00:1]", "https://100.64.1.1", "https://[64:ff9b::a9fe:a9fe]", "https://0x7f000001", "https://2130706433"]) {
      expect(() => remoteOrigin(origin), origin).toThrow();
    }
    process.env.SIGIL_NODE_ALLOW_PRIVATE = "on";
    expect(hostAllowed("localhost")).toBe(true);
  });

  it("refuse a public-looking name that resolves to a private address, when connecting", async () => {
    const { guardedFetch } = await import("../src/server/netguard");
    // "localhost." with a trailing dot is a name, not caught by the name check; it resolves on this machine without any network.
    await expect(guardedFetch("http://localhost./")).rejects.toThrow(/private network/);
  });
});

describe("agents", () => {
  async function agentIn(o: Awaited<ReturnType<typeof signedUp>>) {
    const a = await agents.createAgent(o.b.api, o.vault, { name: "Helper", kind: "other", read: [], write: [], rules: { remember: true, recall: true, forget: true, handoff: true } });
    const { authToken } = await appKeys(parseAppKey(a.appKey).secret);
    return { ...a, token: authToken };
  }

  it("cannot mark another vault's handoff notes as picked", async () => {
    const one = await signedUp(h);
    const two = await signedUp(h);
    const a = await agentIn(one);
    const b = await agentIn(two);
    const hid = randomId();
    const sealed = await encryptJson(one.vault.key, { note: "x" }, "test");
    const left = await h.raw("POST", "connector/v1/handoffs", { body: { id: hid, sealed, spaceId: null }, headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" } });
    expect(left.status).toBe(201);
    const picked = await h.raw("POST", "connector/v1/handoffs/picked", { body: { ids: [hid] }, headers: { authorization: `Bearer ${b.token}`, "content-type": "application/json" } });
    expect(picked.status).toBe(200);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM handoff_picks WHERE handoff_id = ?", hid)).toBe(0);
    // Its own agent may.
    await h.raw("POST", "connector/v1/handoffs/picked", { body: { ids: [hid] }, headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" } });
    expect(count(h.db, "SELECT COUNT(*) AS n FROM handoff_picks WHERE handoff_id = ?", hid)).toBe(1);
  });

  it("are never made admins of a shared memory", async () => {
    const o = await signedUp(h);
    const a = await agentIn(o);
    await agents.createSpace(o.b.api, o.data, "Team", "Sam");
    const data = await ops.loadVault(o.b.api, o.vault);
    const space = data.spaces[0];
    const app = data.apps.find((x) => x.id === a.appId)!;
    await expect(agents.addAgentMember(o.b.api, o.vault, space, app, "admin" as "write")).rejects.toMatchObject({ status: 400 });
    await agents.addAgentMember(o.b.api, o.vault, space, app, "write");
    expect(count(h.db, "SELECT COUNT(*) AS n FROM space_members WHERE app_id = ?", a.appId)).toBe(1);
  });
});

describe("background sync", () => {
  it("gives back the write right it lent an app when it stops", async () => {
    const o = await signedUp(h);
    const folder = o.data.folders[0];
    const app = await ops.connectApp(o.b.api, o.vault, { name: "Connector", kind: "claude-desktop" }, []);
    const env = (aad: string) => encryptJson(o.vault.key, { v: 1 }, aad);
    const sourceId = randomId();
    await o.b.api.post("sync", { id: sourceId, folderId: folder.id, ownerBox: await env("a"), rev: 0 });
    await o.b.api.put(`sync/${sourceId}/app`, { appId: app.appId, appBox: await env("b"), appRev: 1, wrappedKey: await env("c") });
    expect((h.db.prepare("SELECT mode FROM grants WHERE app_id = ? AND folder_id = ?").get(app.appId, folder.id) as { mode: string }).mode).toBe("write");
    await o.b.api.del(`sync/${sourceId}/app`);
    expect((h.db.prepare("SELECT mode FROM grants WHERE app_id = ? AND folder_id = ?").get(app.appId, folder.id) as { mode: string }).mode).toBe("read");
  });
});

describe("a connector's backup", () => {
  it("puts the protected memories it carries on the record", async () => {
    const o = await signedUp(h);
    const health = await guard.setFolderGuard(o.b.api, await ops.addFolder(o.b.api, o.vault, "Health"), { protect: "health" });
    await ops.createMemory(o.b.api, health, { title: "Pills", body: "Twice a day" });
    const app = await ops.connectApp(o.b.api, o.vault, { name: "Backup", kind: "other" }, []);
    const data = await ops.loadVault(o.b.api, o.vault);
    await storage.setConnectorBackup(o.b.api, o.vault, data, data.apps.find((a) => a.id === app.appId)!, true);
    const reader = readerFor(h, app.appKey);
    await reader.request("GET", "backup/bundle");
    const logged = count(h.db, "SELECT COUNT(*) AS n FROM read_log WHERE app_id = ? AND kind = 'protected'", app.appId);
    expect(logged).toBe(1);
  });
});

describe("agreements", () => {
  it("stay with the other party when one side deletes its vault", async () => {
    const a = await signedUp(h);
    const b = await signedUp(h);
    const aId = userIdOf(h.db, a.data.boxPublic!);
    const bId = userIdOf(h.db, b.data.boxPublic!);
    const now = new Date().toISOString();
    h.db
      .prepare(
        "INSERT INTO agreements (id, from_id, to_id, from_key, to_key, hash, version, previous, offer, from_box, to_box, from_sig, to_sig, state, created_at, signed_at) VALUES (?, ?, ?, 'k1', 'k2', ?, 1, NULL, 'o', 'fb', 'tb', 's1', 's2', 'signed', ?, ?)",
      )
      .run("agreement-001", aId, bId, `0x${"12".repeat(32)}`, now, now);
    await a.b.api.del("account");
    expect(h.db.prepare("SELECT from_id, to_id, from_removed FROM agreements WHERE id = 'agreement-001'").get()).toEqual({ from_id: null, to_id: bId, from_removed: 1 });
    expect((await b.b.api.get<{ agreements: { id: string }[] }>("agreements")).agreements.map((x) => x.id)).toEqual(["agreement-001"]);
  });
});
