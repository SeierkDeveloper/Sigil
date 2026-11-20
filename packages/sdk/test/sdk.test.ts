// The consent flow against a stand-in window, and the client against a
// stand-in server that holds only ciphertext.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appKeys,
  buildMemory,
  createApp,
  createFolder,
  encryptMemory,
  formatAppKey,
  importKey,
  newAppSecret,
  newVaultKey,
  type Fetcher,
} from "@sigil/core";
import { consentUrl, requestAccess, SigilAccessError, SigilClient } from "../src/index";

const VAULT = "https://vault.example";
const APP = "https://notes.example";

function fakeWindow() {
  const listeners = new Set<(e: MessageEvent) => void>();
  const popup = { closed: false };
  const opened: string[] = [];
  const w = {
    location: { origin: APP },
    crypto: globalThis.crypto,
    open: (url: string) => (opened.push(url), popup as unknown as Window),
    addEventListener: (_: string, fn: (e: MessageEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: MessageEvent) => void) => listeners.delete(fn),
  };
  const post = (origin: string, data: unknown) => {
    for (const fn of [...listeners]) fn({ origin, data } as MessageEvent);
  };
  const state = () => new URL(opened[0]).searchParams.get("state")!;
  return { w: w as unknown as Window, popup, opened, post, state, listeners };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("requestAccess", () => {
  it("opens the consent window with the app's own origin and a fresh state", async () => {
    const f = fakeWindow();
    const p = requestAccess({ vault: `${VAULT}/vault`, appName: "  Notes  ", suggest: true, window: f.w });
    const url = new URL(f.opened[0]);
    expect(url.origin + url.pathname).toBe(`${VAULT}/vault/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ name: "Notes", origin: APP, suggest: "1" });
    expect(f.state()).toMatch(/^[A-Za-z0-9_-]{32}$/);
    f.post(VAULT, { type: "sigil:denied", state: f.state() });
    await expect(p).rejects.toMatchObject({ code: "denied" });
    expect(f.listeners.size).toBe(0);
  });

  it("takes the key only from the vault's origin and for this request", async () => {
    const f = fakeWindow();
    const p = requestAccess({ vault: VAULT, appName: "Notes", window: f.w });
    const key = formatAppKey("webapp123456", newAppSecret());
    f.post("https://evil.example", { type: "sigil:authorized", state: f.state(), appKey: key });
    f.post(VAULT, { type: "sigil:authorized", state: "another-request-state-000000", appKey: key });
    f.post(VAULT, { type: "sigil:authorized", state: f.state(), appKey: key });
    await expect(p).resolves.toEqual({ appKey: key, vault: VAULT });
  });

  it("fails plainly when the window is blocked, closed, silent or sends a bad key", async () => {
    const blocked = fakeWindow();
    (blocked.w as unknown as { open: () => null }).open = () => null;
    await expect(requestAccess({ vault: VAULT, appName: "Notes", window: blocked.w })).rejects.toMatchObject({ code: "blocked" });

    const closed = fakeWindow();
    const p1 = requestAccess({ vault: VAULT, appName: "Notes", window: closed.w });
    closed.popup.closed = true;
    vi.advanceTimersByTime(500);
    await expect(p1).rejects.toBeInstanceOf(SigilAccessError);

    const silent = fakeWindow();
    const p2 = requestAccess({ vault: VAULT, appName: "Notes", window: silent.w, timeoutMs: 1000 });
    vi.advanceTimersByTime(1001);
    await expect(p2).rejects.toMatchObject({ code: "timeout" });

    const bad = fakeWindow();
    const p3 = requestAccess({ vault: VAULT, appName: "Notes", window: bad.w });
    bad.post(VAULT, { type: "sigil:authorized", state: bad.state(), appKey: "not-a-key" });
    await expect(p3).rejects.toMatchObject({ code: "invalid" });

    await expect(requestAccess({ vault: "nope", appName: "Notes", window: fakeWindow().w })).rejects.toMatchObject({ code: "invalid" });
  });

  it("builds the consent address", () => {
    expect(consentUrl("https://vault.example/x", "N", APP, "s".repeat(20))).toBe(`${VAULT}/vault/authorize?name=N&origin=https%3A%2F%2Fnotes.example&state=${"s".repeat(20)}`);
  });
});

describe("SigilClient", () => {
  it("reads only what it was given and decrypts it in the page", async () => {
    vi.useRealTimers();
    const vaultKey = await importKey(newVaultKey());
    const { stored: work, folder } = await createFolder(vaultKey, "Work");
    const memory = buildMemory({ title: "Launch plan", body: "Ship on a Tuesday." }, folder.id);
    const stored = await encryptMemory(folder, memory);
    const app = await createApp(vaultKey, { name: "Notes (notes.example)", kind: "web" }, [folder]);
    const token = (await appKeys(await secretOf(app.appKey))).authToken;
    const seen: string[] = [];
    const fetcher: Fetcher = async (input, init = {}) => {
      const url = new URL(input);
      seen.push(`${init.method} ${url.pathname} ${init.body ?? ""}`);
      if (new Headers(init.headers).get("authorization") !== `Bearer ${token}`) return Response.json({ error: "revoked" }, { status: 401 });
      const folders = [{ id: work.id, meta: work.meta, wrappedKey: app.stored.grants[0].wrappedKey, count: 1 }];
      if (url.pathname.endsWith("/folders")) return Response.json({ folders });
      if (url.pathname.endsWith("/index")) return Response.json({ folders, memories: [{ id: stored.id, folderId: stored.folderId, head: stored.head }] });
      if (url.pathname.endsWith("/read")) return Response.json({ folders, memories: [stored], missing: [] });
      return new Response("", { status: 404 });
    };
    const client = new SigilClient({ vault: VAULT, appKey: app.appKey, fetch: fetcher });
    expect(await client.folders()).toEqual([{ id: work.id, name: "Work", memories: 1 }]);
    expect((await client.search("tuesday")).map((r) => r.title)).toEqual(["Launch plan"]);
    expect((await client.read([memory.id])).memories[0].body).toBe("Ship on a Tuesday.");
    expect(seen.join("\n")).not.toContain("tuesday");
    expect(seen.every((s) => s.includes("/api/connector/v1/"))).toBe(true);
    const revoked = new SigilClient({ vault: VAULT, appKey: formatAppKey("webapp000000", newAppSecret()), fetch: fetcher });
    await expect(revoked.folders()).rejects.toMatchObject({ status: 401 });
  });
});

async function secretOf(appKey: string) {
  const { parseAppKey } = await import("@sigil/core");
  return parseAppKey(appKey).secret;
}
