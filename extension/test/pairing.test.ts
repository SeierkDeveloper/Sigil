// The extension's crypto path end to end against a stand-in server: pairing
// checks the vault public key, suggestions are sealed in the browser, the
// server only ever holds sealed boxes, and only the vault's key opens them.

import { describe, expect, it } from "vitest";
import {
  appBoxTag,
  appKeys,
  createBoxKey,
  DecryptError,
  encodeBoxPublicKey,
  formatAppKey,
  importKey,
  newAppSecret,
  newBoxKeyPair,
  newVaultKey,
  openProposal,
  type Fetcher,
} from "@sigil/core";
import { cleanBaseUrl, pair, send, type Settings, type SettingsStore } from "../src/pairing";
import { pageDraft } from "../src/capture";

const CANARY = "CANARY-extension-plaintext-77b2";

function memoryStore(): SettingsStore & { value: Settings | null } {
  const s = {
    value: null as Settings | null,
    get: async () => s.value,
    set: async (v: Settings) => void (s.value = v),
    clear: async () => void (s.value = null),
  };
  return s;
}

async function vaultAndServer(opts: { enabled?: boolean; swapKey?: boolean } = {}) {
  const vaultKey = await importKey(newVaultKey());
  const { stored, pair: box } = await createBoxKey(vaultKey);
  const appId = "extapp123456";
  const secret = newAppSecret();
  const appKey = formatAppKey(appId, secret);
  const token = (await appKeys(secret)).authToken;
  const tag = await appBoxTag(secret, stored.publicKey);
  const served = opts.swapKey ? encodeBoxPublicKey(newBoxKeyPair().publicKey) : stored.publicKey;
  const proposals: { id: string; appId: string; sealed: string }[] = [];
  const wire: string[] = [];
  const fetcher: Fetcher = async (input, init = {}) => {
    const url = new URL(input);
    if (typeof init.body === "string") wire.push(init.body);
    const auth = new Headers(init.headers).get("authorization");
    if (auth !== `Bearer ${token}`) return Response.json({ error: "revoked", code: "app_revoked" }, { status: 401 });
    if (url.pathname === "/api/connector/v1/inbox") {
      if (opts.enabled === false) return Response.json({ error: "off", code: "propose_off" }, { status: 403 });
      return Response.json({ appId, publicKey: served, tag });
    }
    if (url.pathname === "/api/connector/v1/proposals" && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      proposals.push({ id: body.id, appId, sealed: body.sealed });
      return Response.json({ id: body.id }, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  };
  return { box, appKey, fetcher, proposals, wire };
}

describe("pairing and sending", () => {
  it("pairs after checking the key, seals in the browser, and only the vault opens it", async () => {
    const v = await vaultAndServer();
    const store = memoryStore();
    await pair(store, "https://vault.example/some/page", v.appKey, v.fetcher);
    expect(store.value).toEqual({ baseUrl: "https://vault.example", appKey: v.appKey });

    const n = await send(store, [pageDraft({ title: `Recipe ${CANARY}`, url: "https://example.org/r", text: `Rye and honey ${CANARY}` })], v.fetcher);
    expect(n).toBe(1);
    expect(v.wire.join("\n")).not.toContain(CANARY);
    expect(v.wire.join("\n")).not.toContain("Rye");

    const opened = openProposal(v.box, v.proposals[0]);
    expect(opened).toMatchObject({ title: `Recipe ${CANARY}`, via: "extension", url: "https://example.org/r", tags: ["web", "page"] });
    expect(() => openProposal(newBoxKeyPair(), v.proposals[0])).toThrow(DecryptError);
  });

  it("refuses to pair or send when the server hands out a key the vault did not vouch for", async () => {
    const v = await vaultAndServer({ swapKey: true });
    const store = memoryStore();
    await expect(pair(store, "https://vault.example", v.appKey, v.fetcher)).rejects.toThrow("could not be verified");
    expect(store.value).toBeNull();
    store.value = { baseUrl: "https://vault.example", appKey: v.appKey };
    await expect(send(store, [{ title: "x", body: CANARY }], v.fetcher)).rejects.toThrow("could not be verified");
    expect(v.proposals).toEqual([]);
    expect(v.wire.join("\n")).not.toContain(CANARY);
  });

  it("explains when the key may not suggest, or is not a key, or nothing is paired", async () => {
    const v = await vaultAndServer({ enabled: false });
    await expect(pair(memoryStore(), "https://vault.example", v.appKey, v.fetcher)).rejects.toThrow("turn on suggestions");
    await expect(pair(memoryStore(), "https://vault.example", "not-a-key", v.fetcher)).rejects.toThrow("not a Sigil app key");
    await expect(send(memoryStore(), [{ title: "x", body: "y" }], v.fetcher)).rejects.toThrow("Pair the extension");
  });

  it("accepts only https addresses, or a vault on this computer", () => {
    expect(cleanBaseUrl(" https://vault.example/x?y ")).toBe("https://vault.example");
    expect(cleanBaseUrl("http://localhost:3210/vault")).toBe("http://localhost:3210");
    expect(() => cleanBaseUrl("http://vault.example")).toThrow();
    expect(() => cleanBaseUrl("vault.example")).toThrow();
  });
});
