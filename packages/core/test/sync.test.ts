import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { createHash } from "node:crypto";
import {
  authorizeUrl,
  calendarRef,
  createFolder,
  decryptJson,
  exchangeCode,
  gmailThreadRef,
  makeSnippet,
  meetingDraft,
  newAppSecret,
  newPkce,
  newVaultKey,
  openSyncForApp,
  openSyncState,
  parseTranscript,
  pkceChallenge,
  refreshTokens,
  runSyncPass,
  sealSyncForApp,
  sealSyncState,
  slackText,
  syncCalendar,
  syncDrive,
  syncGmail,
  syncMemoryId,
  syncSlack,
  SyncError,
  vaultCryptoKey,
  type Memory,
  type ModelCaller,
  type SyncState,
  type SyncTarget,
} from "../src";
import { calendarWorld, driveWorld, gmailMessage, gmailWorld, json, fake, slackWorld, tokenServer } from "./fixtures/sync";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");

describe("OAuth with PKCE on the device", () => {
  it("makes the S256 challenge: base64url of the SHA-256 of the verifier", () => {
    const v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r7wW1gFWFOEjXk";
    expect(pkceChallenge(v)).toBe(createHash("sha256").update(v).digest("base64url"));
    const p = newPkce();
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.challenge).toBe(pkceChallenge(p.verifier));
  });

  it("asks Google for read-only access, offline, with the challenge and no secret", () => {
    const u = new URL(authorizeUrl({ kind: "gmail", clientId: "cid.apps", redirectUri: "https://vault.example/vault/connect", pkce: { challenge: "CH", state: "ST" } }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: "cid.apps",
      response_type: "code",
      code_challenge: "CH",
      code_challenge_method: "S256",
      state: "ST",
      access_type: "offline",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    });
    expect(u.toString()).not.toContain("secret");
    const s = new URL(authorizeUrl({ kind: "slack", clientId: "1.2", redirectUri: "https://vault.example/vault/connect", pkce: { challenge: "CH", state: "ST" } }));
    expect(s.searchParams.get("user_scope")).toContain("channels:history");
  });

  it("trades the code with the verifier, and refreshes", async () => {
    const t = tokenServer();
    const r = await exchangeCode({ kind: "gmail", clientId: "cid", redirectUri: "https://v/x", code: "good-code", verifier: "ver", fetch: t.fetch, now: NOW });
    expect(r.tokens).toEqual({ access: "ya29.CANARY-access", refresh: "1//CANARY-refresh", expiresAt: new Date(NOW + 3599_000).toISOString(), scope: "https://www.googleapis.com/auth/gmail.readonly" });
    const form = new URLSearchParams(t.calls[0].body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: "authorization_code", code: "good-code", redirect_uri: "https://v/x", client_id: "cid", code_verifier: "ver" });
    await expect(exchangeCode({ kind: "gmail", clientId: "cid", redirectUri: "https://v/x", code: "bad", verifier: "ver", fetch: t.fetch })).rejects.toThrow(SyncError);
    const fresh = await refreshTokens({ kind: "gmail", clientId: "cid", tokens: r.tokens, fetch: t.fetch, now: NOW });
    expect(fresh.access).toBe("ya29.fresh");
    expect(fresh.refresh).toBe("1//CANARY-refresh");
    const slack = await exchangeCode({ kind: "slack", clientId: "cid", redirectUri: "https://v/x", code: "good-code", verifier: "ver", fetch: tokenServer({ slack: true }).fetch, now: NOW });
    expect(slack.tokens.access).toBe("xoxp-CANARY-access");
    expect(slack.account).toBe("Team");
  });
});

describe("Gmail", () => {
  it("lists recent threads over two passes, then takes only what changed", async () => {
    const g = gmailWorld();
    const ctx = { token: "tok", fetch: g.fetch, now: NOW };
    const first = await syncGmail({ ...ctx, cursor: null });
    expect(first.account).toBe("me@example.org");
    expect(first.more).toBe(true);
    expect(first.items.map((i) => i.draft.title)).toEqual(["Launch plan", "Your receipt"]);
    const launch = first.items[0];
    expect(launch.ref).toBe(gmailThreadRef("18c2a1f3b4d5e6f7"));
    expect(launch.ref).toBe(BigInt("0x18c2a1f3b4d5e6f7").toString());
    expect(launch.draft.body).toContain("CANARY-mail-1");
    expect(launch.draft.body).toContain("### me");
    // The quoted reply and the attachment are left out.
    expect(launch.draft.body.match(/CANARY-mail-1/g)).toHaveLength(1);
    expect(launch.draft.body).not.toContain("invoice.pdf");
    expect(first.items[1].draft.body).toContain("Thanks for buying");
    expect(g.calls.every((c) => c.auth === "Bearer tok")).toBe(true);

    const second = await syncGmail({ ...ctx, cursor: first.cursor });
    // The spam thread is not kept.
    expect(second.items).toHaveLength(0);
    expect(second.removed).toEqual([gmailThreadRef("18c2a1f3b4d5e6f9")]);
    expect(second.more).toBe(false);

    g.arrive(gmailMessage({ id: "m5", threadId: "18c2a1f3b4d5e6f7", from: "Robin", to: "me", subject: "Re: Launch plan", at: "2026-11-19T09:00:00Z", text: "CANARY-mail-new moved to the 25th" }));
    g.remove("18c2a1f3b4d5e6f8");
    const third = await syncGmail({ ...ctx, cursor: second.cursor });
    expect(third.items.map((i) => i.ref)).toEqual([launch.ref]);
    expect(third.items[0].draft.body).toContain("CANARY-mail-new");
    expect(third.removed).toEqual([gmailThreadRef("18c2a1f3b4d5e6f8")]);
    expect(JSON.parse(third.cursor).historyId).toBe("5002");

    // A history id the API has forgotten starts the listing over.
    const stale = await syncGmail({ ...ctx, cursor: JSON.stringify({ historyId: "stale", pageToken: null, phase: "history" }) });
    expect(stale).toMatchObject({ cursor: "", more: true });
  });
});

describe("Calendar and Drive", () => {
  it("pages to a sync token, then gets changes; cancelled events are removed; an expired token starts over", async () => {
    const c = calendarWorld();
    const ctx = { token: "tok", fetch: c.fetch, now: NOW };
    const a = await syncCalendar({ ...ctx, cursor: null });
    expect(a.more).toBe(true);
    expect(a.items[0].draft.body).toContain("When: 2026-11-24 10:00 Europe/Paris");
    expect(a.items[0].draft.body).toContain("Guests: The clinic");
    const b = await syncCalendar({ ...ctx, cursor: a.cursor });
    expect(b.items[0].draft.body).toContain("(all day)");
    expect(JSON.parse(b.cursor).syncToken).toBe("sync-1");
    c.setChanges([{ id: "evt1", status: "cancelled", iCalUID: "evt1@google.com" }]);
    const d = await syncCalendar({ ...ctx, cursor: b.cursor });
    expect(d.removed).toEqual(["evt1@google.com"]);
    const e = await syncCalendar({ ...ctx, cursor: JSON.stringify({ syncToken: "expired", pageToken: null }) });
    expect(e).toMatchObject({ cursor: "", more: true });
    expect(calendarRef({ id: "x_2026", iCalUID: "r@google.com", recurringEventId: "r", originalStartTime: { dateTime: "2026-01-15T09:30:00Z" } })).toBe("r@google.com#20260115T093000Z");
  });

  it("reads Docs and text files as text, skips the rest, and follows changes", async () => {
    const d = driveWorld();
    const ctx = { token: "tok", fetch: d.fetch, now: NOW };
    const a = await syncDrive({ ...ctx, cursor: null });
    expect(a.items.map((i) => i.draft.title)).toEqual(["Book outline", "notes.md"]);
    expect(a.items[0].draft.body).toMatch(/^CANARY-doc Chapter one\.\nChapter two\./);
    expect(a.items[0].draft.body).toContain("In Drive: https://docs.google.com/document/d/doc1");
    const b = await syncDrive({ ...ctx, cursor: a.cursor });
    expect(b.removed).toEqual(["txt1"]);
    expect(b.items[0].draft.title).toBe("Book outline v2");
    expect(JSON.parse(b.cursor).startPageToken).toBe("101");
  });
});

describe("Slack", () => {
  it("makes one memory per channel and day, with names, and only fetches what is new", async () => {
    const s = slackWorld(Math.floor(NOW / 1000));
    const ctx = { token: "xoxp", fetch: s.fetch, now: NOW };
    const a = await syncSlack({ ...ctx, cursor: null });
    expect(a.account).toBe("Team");
    expect(a.items.map((i) => i.draft.title).sort()).toEqual([expect.stringMatching(/^#general, 2026-11-1\d$/), expect.stringMatching(/^Direct message with Robin, /)].sort());
    const general = a.items.find((i) => i.draft.title.startsWith("#general"))!;
    expect(general.draft.body).toContain("### Sam,");
    expect(general.draft.body).toContain("CANARY-slack @Robin can you ship the doc (https://example.org/x)?");
    expect(general.draft.body).toContain("Yes, by Friday in #general");
    expect(general.draft.body).not.toContain("joined");
    expect(s.calls.every((c) => new URLSearchParams(c.body).get("token") === "xoxp")).toBe(true);
    const b = await syncSlack({ ...ctx, cursor: a.cursor });
    expect(b.items).toHaveLength(0);
    expect(slackText("<!here> <@U9>", new Map(), new Map())).toBe("@here @someone");
    await expect(syncSlack({ ...ctx, token: "revoked", cursor: null })).rejects.toThrow(SyncError);
  });
});

describe("a sync pass", () => {
  async function setup() {
    const vk = await vaultCryptoKey(newVaultKey());
    const { folder } = await createFolder(vk, "Mail");
    const saved = new Map<string, Memory>();
    const deleted: string[] = [];
    const target: SyncTarget = {
      folder,
      existing: (kind, ref) => {
        const m = [...saved.values()].find((x) => x.source.kind === kind && x.source.ref === ref);
        return m ? { id: m.id, folderId: m.folderId, title: m.title, snippet: makeSnippet(m.body), editedAt: m.editedAt, createdAt: m.createdAt } : null;
      },
      put: async (ms) => void ms.forEach((m) => saved.set(m.id, m)),
      remove: async (ids) => void ids.forEach((id) => (deleted.push(id), saved.delete(id))),
    };
    return { vk, folder, saved, deleted, target };
  }

  const state = (over: Partial<SyncState> = {}): SyncState => ({
    v: 1,
    kind: "gmail",
    folderId: "f",
    clientId: "cid",
    tokens: { access: "tok", refresh: "1//r", expiresAt: new Date(NOW + 3600_000).toISOString(), scope: "" },
    cursor: null,
    account: "",
    rev: 1,
    last: null,
    ...over,
  });

  it("writes new things under ids from the folder key, updates what it holds, skips what did not change, and deletes what is gone", async () => {
    const { folder, saved, deleted, target } = await setup();
    const g = gmailWorld();
    const r = await runSyncPass(state(), { target, fetch: g.fetch, now: NOW });
    expect(r).toMatchObject({ added: 2, updated: 0, removed: 0, more: false });
    expect(r.state.account).toBe("me@example.org");
    expect(r.state.rev).toBeGreaterThan(1);
    const launchId = await syncMemoryId(folder.raw, "gmail", gmailThreadRef("18c2a1f3b4d5e6f7"));
    expect(saved.get(launchId)?.title).toBe("Launch plan");

    const again = await runSyncPass(r.state, { target, fetch: g.fetch, now: NOW });
    expect(again).toMatchObject({ added: 0, updated: 0 });

    g.arrive(gmailMessage({ id: "m6", threadId: "18c2a1f3b4d5e6f7", from: "Robin", to: "me", subject: "Re: Launch plan", at: "2026-11-19T09:00:00Z", text: "CANARY-update" }));
    g.remove("18c2a1f3b4d5e6f8");
    const third = await runSyncPass(again.state, { target, fetch: g.fetch, now: NOW });
    expect(third).toMatchObject({ added: 0, updated: 1, removed: 1 });
    expect(saved.get(launchId)?.body).toContain("CANARY-update");
    expect(deleted).toHaveLength(1);
    expect(third.state.last).toMatchObject({ added: 0, updated: 1, removed: 1, error: null });
  });

  it("writes onto a memory a Takeout import made, in its own folder", async () => {
    const { saved, target } = await setup();
    saved.set("imported-1", { id: "imported-1", folderId: "google", title: "Launch plan", body: "old", tags: [], source: { kind: "gmail", ref: BigInt("0x18c2a1f3b4d5e6f7").toString() }, snippet: "old", createdAt: "2026-01-01T00:00:00.000Z", editedAt: "2026-01-01T00:00:00.000Z" });
    const r = await runSyncPass(state(), { target, fetch: gmailWorld().fetch, now: NOW });
    expect(r.updated).toBe(1);
    expect(saved.get("imported-1")).toMatchObject({ folderId: "google", createdAt: "2026-01-01T00:00:00.000Z" });
  });

  it("refreshes an expired token first, and once more when the provider says no", async () => {
    const { target } = await setup();
    const g = gmailWorld();
    const t = tokenServer({ refreshTo: "ya29.second" });
    let refused = true;
    const both = fake([
      [/oauth2\.googleapis\.com/, (u, init) => t.fetch(u.toString(), init)],
      [
        /gmail/,
        (u, init) => {
          if (new Headers(init?.headers).get("authorization") === "Bearer stale" && refused) return json({ error: { code: 401 } }, 401);
          return g.fetch(u.toString(), init);
        },
      ],
    ]);
    const expired = await runSyncPass(state({ tokens: { access: "old", refresh: "1//r", expiresAt: new Date(NOW - 1000).toISOString(), scope: "" } }), { target, fetch: both.fetch, now: NOW, maxPasses: 1 });
    expect(expired.state.tokens.access).toBe("ya29.second");
    const rejected = await runSyncPass(state({ tokens: { access: "stale", refresh: "1//r", expiresAt: null, scope: "" } }), { target, fetch: both.fetch, now: NOW, maxPasses: 1 });
    expect(rejected.state.tokens.access).toBe("ya29.second");
    refused = false;
    await expect(runSyncPass(state({ tokens: { access: "stale", refresh: null, expiresAt: null, scope: "" } }), { target, fetch: fake([[/gmail/, () => json({}, 401)]]).fetch, now: NOW })).rejects.toThrow(SyncError);
  });
});

describe("the stored state of a source", () => {
  it("is encrypted with the vault key, and for a background connector with a key from its secret", async () => {
    const vk = await vaultCryptoKey(newVaultKey());
    const s: SyncState = { v: 1, kind: "slack", folderId: "f1", clientId: "c", tokens: { access: "xoxp-CANARY", refresh: "xoxe-CANARY", expiresAt: null, scope: "" }, cursor: null, account: "Team", rev: 3, last: null };
    const owner = await sealSyncState(vk, "src-00001", s);
    expect(owner).not.toContain("CANARY");
    expect(await openSyncState(vk, "src-00001", owner)).toEqual(s);
    await expect(openSyncState(vk, "src-00002", owner)).rejects.toThrow();
    const secret = newAppSecret();
    const app = await sealSyncForApp(secret, "app-0001", "src-00001", s);
    expect(await openSyncForApp(secret, "app-0001", "src-00001", app)).toEqual(s);
    await expect(openSyncForApp(newAppSecret(), "app-0001", "src-00001", app)).rejects.toThrow();
    await expect(decryptJson(vk, app, "sigil:sync:src-00001")).rejects.toThrow();
  });
});

describe("meeting transcripts", () => {
  const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
<v Sam>Thanks for coming. We decided to launch on the 24th.</v>

2
00:00:05.000 --> 00:00:09.000
<v Robin>Good. I'll send the press note by Friday.</v>

3
00:00:10.000 --> 00:00:12.000
Robin: And I will check the numbers.`;

  it("reads VTT, SRT, plain text and Word files", () => {
    const t = parseTranscript("call.vtt", strToU8(vtt));
    expect(t.speakers).toEqual(["Sam", "Robin"]);
    expect(t.turns[1].text).toContain("press note");
    const srt = parseTranscript("call.srt", strToU8("1\n00:00:01,000 --> 00:00:02,000\nSam: Hello there.\n\n2\n00:00:03,000 --> 00:00:04,000\nRobin: Hi Sam.\n"));
    expect(srt.speakers).toEqual(["Sam", "Robin"]);
    const txt = parseTranscript("meet.txt", strToU8("00:00:01\nSam: First point.\nRobin  0:05\nSecond point here.\n[00:01:00] Sam: Last one."));
    expect(txt.turns.map((x) => x.speaker)).toEqual(["Sam", "Robin", "Sam"]);
    const docx = zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "word/document.xml": strToU8('<w:document><w:body><w:p><w:r><w:t>Sam: We agreed on blue &amp; white.</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Robin: I will draw it.</w:t></w:r></w:p></w:body></w:document>'),
    });
    const d = parseTranscript("notes.docx", docx);
    expect(d.turns).toEqual([
      { speaker: "Sam", text: "We agreed on blue & white." },
      { speaker: "Robin", text: "I will draw it." },
    ]);
    expect(() => parseTranscript("x.pdf", strToU8("x"))).toThrow();
  });

  it("makes a meeting memory without a model: who was there, decisions, promises", async () => {
    const { draft, extract } = await meetingDraft("Launch sync.vtt", strToU8(vtt));
    expect(extract.by).toBe("rules");
    expect(extract.attendees).toEqual(["Sam", "Robin"]);
    expect(extract.decisions).toEqual(["We decided to launch on the 24th."]);
    expect(extract.promises).toEqual([
      { who: "Robin", what: "I'll send the press note by Friday." },
      { who: "Robin", what: "And I will check the numbers." },
    ]);
    expect(draft.title).toBe("Meeting: Launch sync");
    expect(draft.body).toContain("## Who was there\n- Sam\n- Robin");
    expect(draft.body).toContain("## Transcript\nSam: Thanks for coming.");
    expect(draft.source).toMatchObject({ kind: "meeting" });
  });

  it("lets the owner's model write the extract, and falls back when it answers badly", async () => {
    const calls: string[] = [];
    const model: ModelCaller = {
      provider: "anthropic",
      model: "claude-opus-5-5",
      complete: async (r) => (calls.push(r.messages[0].content), '```json\n{"title":"Launch call","summary":"Date set.","decisions":["Launch on the 24th"],"promises":[{"who":"Robin","what":"Press note by Friday"}]}\n```'),
    };
    const { extract, draft } = await meetingDraft("call.vtt", strToU8(vtt), { model });
    expect(extract).toMatchObject({ by: "model", title: "Launch call", decisions: ["Launch on the 24th"], promises: [{ who: "Robin", what: "Press note by Friday" }] });
    expect(calls[0]).toContain("<transcript>");
    expect(draft.body).toContain("written by your own model");
    const bad: ModelCaller = { provider: "anthropic", model: "m", complete: async () => "I cannot help." };
    expect((await meetingDraft("call.vtt", strToU8(vtt), { model: bad })).extract.by).toBe("rules");
  });
});
