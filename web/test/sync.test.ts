// Live sync, end to end in-process: connecting a source with PKCE in the
// browser, the tokens and cursor stored only encrypted, passes in the open
// vault writing encrypted memories, pause and disconnect, and a connector
// carrying on in the background. The providers are played by recorded fixtures;
// nothing reaches Google or Slack.

import { beforeEach, describe, expect, it } from "vitest";
import { gmailThreadRef, syncMemoryId } from "@sigil/core";
import { count, dumpDb, harness, readerFor, signedUp, ORIGIN, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as sync from "../src/vault/syncOps";
import { SyncWorker } from "../../connector/src/sync";
import { calendarWorld, fake, gmailMessage, gmailWorld, json, tokenServer } from "../../packages/core/test/fixtures/sync";

let h: Harness;
beforeEach(() => {
  h = harness();
});

/** The Google side of the world: the token endpoint and the APIs, behind one fetch. */
function google() {
  const tokens = tokenServer();
  const mail = gmailWorld();
  const cal = calendarWorld();
  const all = fake([
    [/oauth2\.googleapis\.com/, (u, init) => tokens.fetch(u.toString(), init)],
    [/gmail\.googleapis\.com/, (u, init) => mail.fetch(u.toString(), init)],
    [/www\.googleapis\.com\/calendar/, (u, init) => cal.fetch(u.toString(), init)],
  ]);
  return { ...all, tokens, mail, cal };
}

async function connected(kind: "gmail" | "calendar" = "gmail") {
  const s = await signedUp(h);
  const folder = await ops.addFolder(s.b.api, s.vault, "Mail");
  const g = google();
  let asked = "";
  const source = await sync.connectSource(s.b.api, s.vault, {
    kind,
    clientId: "cid.apps.example",
    folder,
    origin: ORIGIN,
    fetch: g.fetch,
    authorize: async (url, state) => {
      asked = url;
      return { code: "good-code", state };
    },
  });
  const data = await ops.loadVault(s.b.api, s.vault);
  return { ...s, folder, g, source, data, asked };
}

describe("connecting a source", () => {
  it("runs OAuth with PKCE from the device and keeps the tokens only under the vault key", async () => {
    const s = await connected();
    const u = new URL(s.asked);
    expect(u.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/vault/connect`);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    // The token exchange went from the device to the provider, with the verifier and no secret.
    const form = new URLSearchParams(s.g.tokens.calls[0].body);
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.has("client_secret")).toBe(false);
    expect(s.data.sync).toHaveLength(1);
    expect(s.data.sync[0].state).toMatchObject({ kind: "gmail", folderId: s.folder.id, tokens: { access: "ya29.CANARY-access", refresh: "1//CANARY-refresh" } });
    const db = dumpDb(h.db);
    expect(db).not.toContain("CANARY-access");
    expect(db).not.toContain("CANARY-refresh");
    expect(db).not.toContain("gmail");
    expect(h.sent.join("\n")).not.toContain("CANARY");
  });

  it("says when no client id is set, and the server never holds a secret", async () => {
    const before = process.env.SIGIL_GOOGLE_CLIENT_ID;
    delete process.env.SIGIL_GOOGLE_CLIENT_ID;
    const s = await signedUp(h);
    expect(await sync.loadClients(s.b.api)).toEqual({ google: null, slack: null });
    process.env.SIGIL_GOOGLE_CLIENT_ID = "123-abc.apps.googleusercontent.com";
    expect((await sync.loadClients(s.b.api)).google).toBe("123-abc.apps.googleusercontent.com");
    if (before === undefined) delete process.env.SIGIL_GOOGLE_CLIENT_ID;
    else process.env.SIGIL_GOOGLE_CLIENT_ID = before;
  });
});

describe("a pass in the open vault", () => {
  it("writes encrypted memories, then only what changed, and keeps the cursor encrypted", async () => {
    const s = await connected();
    const first = await sync.syncNow(s.b.api, s.vault, s.data, s.data.sync[0], { fetch: s.g.fetch });
    expect(first.report).toMatchObject({ added: 2, more: false });
    let data = await ops.loadVault(s.b.api, s.vault);
    const launch = data.memories.find((m) => m.title === "Launch plan")!;
    expect(launch.folderId).toBe(s.folder.id);
    expect(launch.id).toBe(await syncMemoryId(s.folder.raw, "gmail", gmailThreadRef("18c2a1f3b4d5e6f7")));
    expect(dumpDb(h.db)).not.toContain("CANARY-mail-1");
    expect(data.sync[0].state?.last).toMatchObject({ added: 2, error: null });
    // The export lists the source without its sign-in.
    const exported = JSON.stringify(ops.buildExport(data, []).sync);
    expect(exported).toContain("me@example.org");
    expect(exported).not.toContain("CANARY");
    expect(data.sync[0].lastSyncAt).not.toBeNull();

    s.g.mail.arrive(gmailMessage({ id: "m9", threadId: "18c2a1f3b4d5e6f7", from: "Robin", to: "me", subject: "Re: Launch plan", at: "2026-11-19T09:00:00Z", text: "CANARY-later" }));
    const second = await sync.syncNow(s.b.api, s.vault, data, data.sync[0], { fetch: s.g.fetch });
    expect(second.report).toMatchObject({ added: 0, updated: 1 });
    data = await ops.loadVault(s.b.api, s.vault);
    expect(data.memories.find((m) => m.id === launch.id)?.body).toContain("CANARY-later");
    expect(data.memories.filter((m) => m.title === "Launch plan")).toHaveLength(1);
  });

  it("dedupes against a memory a Takeout import made, wherever it is", async () => {
    const s = await connected();
    const google = await ops.addFolder(s.b.api, s.vault, "Google");
    await ops.createMemory(s.b.api, google, { title: "Launch plan", body: "from the export", source: { kind: "gmail", ref: gmailThreadRef("18c2a1f3b4d5e6f7") } });
    const data = await ops.loadVault(s.b.api, s.vault);
    await sync.syncNow(s.b.api, s.vault, data, data.sync[0], { fetch: s.g.fetch });
    const after = await ops.loadVault(s.b.api, s.vault);
    const launches = after.memories.filter((m) => m.title === "Launch plan");
    expect(launches).toHaveLength(1);
    expect(launches[0].folderId).toBe(google.id);
  });

  it("pauses, and on disconnect deletes the stored tokens and keeps the memories", async () => {
    const s = await connected();
    await sync.syncNow(s.b.api, s.vault, s.data, s.data.sync[0], { fetch: s.g.fetch });
    await sync.pauseSource(s.b.api, s.source.id, true);
    expect((await ops.loadVault(s.b.api, s.vault)).sync[0].paused).toBe(true);
    await sync.disconnectSource(s.b.api, s.source.id);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM sync_sources")).toBe(0);
    const data = await ops.loadVault(s.b.api, s.vault);
    expect(data.sync).toHaveLength(0);
    expect(data.memories.some((m) => m.title === "Launch plan")).toBe(true);
  });

  it("refuses a stale copy of the state, and another vault's source", async () => {
    const s = await connected();
    await expect(s.b.api.put(`sync/${s.source.id}`, { ownerBox: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA", rev: 1 })).rejects.toMatchObject({ status: 409 });
    const other = await signedUp(h);
    await expect(other.b.api.del(`sync/${s.source.id}`)).rejects.toMatchObject({ status: 404 });
  });

  it("removes a cancelled calendar event", async () => {
    const s = await connected("calendar");
    let data = s.data;
    for (let i = 0; i < 2; i++) {
      await sync.syncNow(s.b.api, s.vault, data, data.sync[0], { fetch: s.g.fetch });
      data = await ops.loadVault(s.b.api, s.vault);
    }
    expect(data.memories.map((m) => m.title).sort()).toEqual(["Dentist", "Team day"]);
    s.g.cal.setChanges([{ id: "evt1", status: "cancelled", iCalUID: "evt1@google.com" }]);
    await sync.syncNow(s.b.api, s.vault, data, data.sync[0], { fetch: s.g.fetch });
    data = await ops.loadVault(s.b.api, s.vault);
    expect(data.memories.map((m) => m.title)).toEqual(["Team day"]);
  });
});

describe("background sync in the connector", () => {
  it("syncs with its own copy of the source, writes only to the source's folder, and the vault reads its newer cursor", async () => {
    const s = await connected();
    const { appKey, appId } = await ops.connectApp(s.b.api, s.vault, { name: "Home machine", kind: "other" }, []);
    let data = await ops.loadVault(s.b.api, s.vault);
    const app = data.apps.find((a) => a.id === appId)!;
    await sync.allowBackground(s.b.api, s.vault, data, data.sync[0], app);

    const sentBefore = h.sent.length;
    const worker = new SyncWorker(readerFor(h, appKey), { fetch: s.g.fetch });
    const reports = await worker.runOnce();
    expect(reports).toEqual([{ id: s.source.id, kind: "gmail", added: 2, updated: 0, removed: 0, error: null }]);
    expect(h.sent.slice(sentBefore).join("\n")).not.toContain("CANARY");
    data = await ops.loadVault(s.b.api, s.vault);
    expect(data.memories.find((m) => m.title === "Launch plan")?.folderId).toBe(s.folder.id);
    // The vault opens the connector's newer copy.
    expect(data.sync[0].state?.rev).toBeGreaterThan(data.sync[0].ownerRev);
    const log = await ops.loadLog(s.b.api);
    expect(log.entries.find((e) => e.kind === "sync")).toMatchObject({ appId, count: 2 });

    // It cannot write outside the source's folder.
    const reader = readerFor(h, appKey);
    const notes = data.folders.find((f) => f.name === "Notes")!;
    await expect(
      reader.request("POST", `sync/${s.source.id}/memories`, { memories: [{ id: "abcdefghijk", folderId: notes.id, head: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA", body: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA" }] }),
    ).rejects.toMatchObject({ status: 403 });

    // Paused: it stops; stopped: it is told so.
    await sync.pauseSource(s.b.api, s.source.id, true);
    expect(await worker.runOnce()).toEqual([]);
    await sync.stopBackground(s.b.api, s.source.id);
    expect(await worker.sources()).toEqual([]);
  });

  it("uses a client secret only from its own machine's environment", async () => {
    const { clientSecretFor } = await import("../../connector/src/sync");
    expect(clientSecretFor("gmail", { SIGIL_GOOGLE_CLIENT_SECRET: " s3cret " })).toBe("s3cret");
    expect(clientSecretFor("slack", { SIGIL_GOOGLE_CLIENT_SECRET: "x" })).toBeUndefined();
    void json;
  });
});
