// Fuzz and property tests for every parser of outside input: exports people
// import, files and mail, transcripts, links and codes, signed documents and
// sealed boxes. Each must either return or throw a plain Error with a message,
// never crash with a TypeError, never hang, and never accept what it should not.
// Seeded, so a failure replays: see fixtures/fuzz.ts.

import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  bundleShapeError,
  canonicalJson,
  cleanAgentRules,
  cleanBackup,
  cleanCard,
  cleanGuard,
  cleanMove,
  cleanOffer,
  cleanQuestion,
  cleanRules,
  cleanSyncState,
  cleanTarget,
  cleanWalletRules,
  decodeBundle,
  decodeHeader,
  decryptBytes,
  fromBase64Url,
  fromHex,
  htmlToText,
  icsDrafts,
  importKey,
  inlineTags,
  mboxDrafts,
  newBoxKeyPair,
  newVaultKey,
  nodeOrigin,
  openAskMessage,
  openSealedJson,
  parseAgreement,
  parseAppKey,
  parseAskFragment,
  parseBundle,
  parseCaptureFragment,
  parseCaptureKey,
  parseCertificate,
  parseChatGptConversations,
  parseClaudeConversations,
  parseClaudeMemories,
  parseClaudeProjects,
  parseDataItem,
  parseDisclosure,
  parseExport,
  parseIdentityStatement,
  parseLegacyInvite,
  parseMailMessage,
  parseMoveCode,
  parsePack,
  parsePairingFragment,
  parseSrt,
  parseTranscript,
  parseTxt,
  parseVaultCode,
  parseVtt,
  redact,
  signPack,
  slackText,
  splitFrontmatter,
  splitMbox,
  vaultSigningKey,
  verifyAgreement,
  verifyBundle,
  verifyCertificate,
  verifyDisclosure,
  verifyIdentityStatement,
  verifyPack,
} from "../src";
import { unzipLimited, ZipTooLarge } from "../src/import/util";
import { FUZZ_RUNS, bytes, int, json, mutate, outcome, outcomeAsync, plainError, rng, str, timed } from "./fixtures/fuzz";

const enc = new TextEncoder();

/** Asserts the call either returns or throws a plain Error. */
function settles(label: string, fn: () => unknown): void {
  const r = outcome(fn);
  if (!r.ok && !plainError(r.error)) throw new Error(`${label} crashed: ${(r.error as Error)?.stack ?? String(r.error)}`);
}

async function settlesAsync(label: string, fn: () => Promise<unknown>): Promise<void> {
  const r = await outcomeAsync(fn);
  if (!r.ok && !plainError(r.error)) throw new Error(`${label} crashed: ${(r.error as Error)?.stack ?? String(r.error)}`);
}

describe("importers of exports", () => {
  it("skip damaged conversations and never stop the whole import", () => {
    const r = rng();
    for (let i = 0; i < FUZZ_RUNS; i++) {
      const list = Array.from({ length: 1 + int(r, 6) }, () => json(r));
      for (const parse of [parseChatGptConversations, parseClaudeConversations]) {
        const out = parse(list);
        expect(out.drafts.length + out.skipped).toBeLessThanOrEqual(list.length);
      }
      expect(() => parseClaudeProjects(json(r))).not.toThrow();
      expect(() => parseClaudeMemories(json(r))).not.toThrow();
    }
  });

  it("read a ChatGPT conversation whose ids are the names of built-in properties", () => {
    const conv = {
      title: "Tricky",
      current_node: "constructor",
      mapping: {
        constructor: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["hello"] } }, parent: "__proto__" },
        ["__proto__"]: { message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["hi"] } }, parent: null },
      },
    };
    const parsed = JSON.parse(JSON.stringify(conv).replace('"__proto__"', '"__proto__"'));
    const out = parseChatGptConversations([parsed]);
    expect(out.drafts.length + out.skipped).toBe(1);
    expect(({} as Record<string, unknown>).message).toBeUndefined();
  });

  it("take any bytes as an export file and refuse what is not one in plain words", () => {
    const r = rng(7);
    for (let i = 0; i < FUZZ_RUNS; i++) {
      const kind = int(r, 4);
      const data =
        kind === 0
          ? bytes(r)
          : kind === 1
            ? enc.encode(JSON.stringify(json(r)))
            : kind === 2
              ? zipSync({ "conversations.json": enc.encode(JSON.stringify([json(r), json(r)])), "x/memories.json": enc.encode(str(r)) })
              : enc.encode(str(r, 400));
      settles("parseExport", () => parseExport(pick2(r, ["conversations.json", "export.zip", "x"]), data));
    }
  });

  it("read mail, calendars, notes and transcripts of any shape", () => {
    const r = rng(11);
    for (let i = 0; i < FUZZ_RUNS; i++) {
      const text = str(r, 600);
      settles("mboxDrafts", () => mboxDrafts(`From a@b.co\n${text}\n\nFrom c@d.co\nSubject: ${str(r, 40)}\n\n${text}`));
      settles("splitMbox", () => splitMbox(text));
      settles("parseMailMessage", () => parseMailMessage(text));
      settles("decodeHeader", () => decodeHeader(text));
      settles("icsDrafts", () => icsDrafts(`BEGIN:VCALENDAR\nBEGIN:VEVENT\n${text}\nEND:VEVENT\nEND:VCALENDAR`));
      settles("htmlToText", () => htmlToText(text));
      settles("splitFrontmatter", () => splitFrontmatter(`---\n${text}\n---\n${text}`));
      settles("inlineTags", () => inlineTags(text));
      settles("parseVtt", () => parseVtt(`WEBVTT\n\n${text}`));
      settles("parseSrt", () => parseSrt(text));
      settles("parseTxt", () => parseTxt(text));
      settles("parseTranscript", () => parseTranscript(pick2(r, ["a.vtt", "a.srt", "a.txt", "a.docx", "a.json"]), r() < 0.5 ? enc.encode(text) : bytes(r)));
      settles("slackText", () => slackText(text, new Map(), new Map()));
      settles("redact", () => redact(text, ["email", "iban", "card", "national_id"]));
    }
  });

  it("stay linear on input built to make a regular expression backtrack", () => {
    const n = 200_000;
    const cases: [string, () => unknown][] = [
      ["html many <", () => htmlToText("<".repeat(n))],
      ["html many <script", () => htmlToText("<script".repeat(n / 7))],
      ["html many <li", () => htmlToText("<li".repeat(n / 3))],
      ["html trailing spaces", () => htmlToText(" ".repeat(n) + "x")],
      ["ics many colons in quotes", () => icsDrafts(`BEGIN:VEVENT\nX;A="${":".repeat(n)}\nEND:VEVENT`)],
      ["ics many quotes", () => icsDrafts(`BEGIN:VEVENT\nX;A=${'":'.repeat(n / 2)}\nEND:VEVENT`)],
      ["mail references", () => mboxDrafts(`From a\nReferences: ${"<".repeat(n)}\n\nhi`)],
      ["redact email", () => redact("a".repeat(n), ["email"])],
      ["redact email dots", () => redact(`${"a.".repeat(n / 2)}@`, ["email"])],
      ["slack links", () => slackText("<http:".repeat(n / 6), new Map(), new Map())],
      ["vtt voice", () => parseVtt(`WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v ${" a".repeat(n / 2)}`)],
    ];
    for (const [label, fn] of cases) {
      const ms = timed(fn);
      expect(ms, label).toBeLessThan(2_000);
    }
  });

  it("refuse a zip that unpacks to more than an import can hold, before inflating it", () => {
    // A zip whose one file holds 2 MB of zeros: refused under a 1 MB ceiling, opened under a larger one.
    const big = zipSync({ "conversations.json": new Uint8Array(2 * 1024 * 1024) }, { level: 9 });
    expect(big.length).toBeLessThan(64 * 1024);
    expect(() => unzipLimited(big, () => true, 1024 * 1024)).toThrow(ZipTooLarge);
    expect(unzipLimited(big, () => true, 4 * 1024 * 1024)["conversations.json"].length).toBe(2 * 1024 * 1024);
    // Through the importer it fails in plain words, never with a crash.
    const r = outcome(() => parseExport("big.zip", big));
    expect(r.ok || plainError((r as { error: unknown }).error)).toBe(true);
  });
});

function pick2<T>(r: () => number, list: T[]): T {
  return list[Math.floor(r() * list.length)];
}

describe("keys, links and codes", () => {
  it("are read from any string, or refused in plain words", () => {
    const r = rng(23);
    for (let i = 0; i < FUZZ_RUNS * 2; i++) {
      const s = str(r, 120);
      for (const [label, fn] of [
        ["fromBase64Url", () => fromBase64Url(s)],
        ["fromHex", () => fromHex(s)],
        ["parseAppKey", () => parseAppKey(s)],
        ["parseCaptureKey", () => parseCaptureKey(s)],
        ["parseCaptureFragment", () => parseCaptureFragment(s)],
        ["parseVaultCode", () => parseVaultCode(s)],
        ["parsePairingFragment", () => parsePairingFragment(s)],
        ["parseAskFragment", () => parseAskFragment(s)],
        ["parseLegacyInvite", () => parseLegacyInvite(s)],
        ["parseMoveCode", () => parseMoveCode(s)],
        ["nodeOrigin", () => nodeOrigin(s)],
      ] as const) {
        settles(label, fn);
      }
    }
  });

  it("never give back a key of the wrong length", () => {
    const r = rng(29);
    for (let i = 0; i < FUZZ_RUNS; i++) {
      const raw = bytes(r, 64);
      const fragment = `${"A".repeat(43)}.${Buffer.from(raw).toString("base64url")}`;
      const got = outcome(() => parseAskFragment(fragment));
      if (got.ok) expect(got.value.introKey.length).toBe(32);
    }
  });

  it("only take https node addresses, or http on this machine", () => {
    expect(() => nodeOrigin("http://node.example")).toThrow();
    expect(() => nodeOrigin("javascript:alert(1)")).toThrow();
    expect(() => nodeOrigin("file:///etc/passwd")).toThrow();
    expect(nodeOrigin("https://node.example/path?x")).toBe("https://node.example");
    // Storage keys and signatures never travel over plain http, except to this machine.
    expect(() => cleanTarget({ kind: "s3", id: "t-000001", label: "B", endpoint: "http://bucket.example", region: "x", bucket: "bucket-one", accessKeyId: "a", secretAccessKey: "s" })).toThrow();
    expect(cleanTarget({ kind: "s3", id: "t-000001", label: "B", endpoint: "http://127.0.0.1:9000", region: "x", bucket: "bucket-one", accessKeyId: "a", secretAccessKey: "s" })).toMatchObject({ endpoint: "http://127.0.0.1:9000" });
  });
});

describe("signed documents", () => {
  it("are parsed from any text, and a random one never checks out", async () => {
    const r = rng(31);
    for (let i = 0; i < FUZZ_RUNS; i++) {
      const text = r() < 0.5 ? JSON.stringify(json(r)) : str(r, 300);
      for (const [label, parse] of [
        ["parseBundle", parseBundle],
        ["parseDisclosure", parseDisclosure],
        ["parseAgreement", parseAgreement],
        ["parsePack", parsePack],
        ["parseIdentityStatement", parseIdentityStatement],
        ["parseCertificate", parseCertificate],
      ] as const) {
        const got = outcome(() => (parse as (t: string) => unknown)(text));
        if (!got.ok) {
          expect(plainError(got.error), `${label}: ${String(got.error)}`).toBe(true);
          continue;
        }
        const doc = got.value as never;
        const verified = await outcomeAsync(async () => {
          if (label === "parseBundle") return verifyBundle(doc);
          if (label === "parseDisclosure") return verifyDisclosure(doc);
          if (label === "parseAgreement") return verifyAgreement(doc);
          if (label === "parsePack") return verifyPack(doc);
          if (label === "parseIdentityStatement") return verifyIdentityStatement(doc);
          return verifyCertificate(doc);
        });
        if (verified.ok) expect((verified.value as { ok: boolean }).ok, label).toBe(false);
        else expect(plainError(verified.error), `${label} verify: ${String(verified.error)}`).toBe(true);
      }
      settles("bundleShapeError", () => bundleShapeError(json(r)));
      settles("decodeBundle", () => decodeBundle(r() < 0.5 ? bytes(r) : enc.encode(text)));
    }
  });

  it("never check out once any part of a signed pack was changed", async () => {
    const r = rng(37);
    const key = await vaultSigningKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    const pack = signPack(key, { id: "pack-0000001", title: "Bread", description: "How I bake.", version: 1, publisher: { name: "Sam" }, previous: null, items: [{ id: "memory-00001", title: "Starter", body: "Twice a day.", tags: ["bread"] }], origin: "https://sigil.example", publishedAt: "2026-11-20T10:00:00.000Z" });
    expect(verifyPack(pack).ok).toBe(true);
    for (let i = 0; i < FUZZ_RUNS; i++) {
      const changed = mutate(r, pack) as typeof pack;
      if (canonicalJson(changed) === canonicalJson(pack)) continue;
      const got = outcome(() => verifyPack(changed));
      if (got.ok) expect(got.value.ok).toBe(false);
      else expect(plainError(got.error)).toBe(true);
    }
    // And a pack from the same publisher with another id is not the one followed.
    const other = signPack(key, { ...pack.body, id: "pack-0000002" });
    expect(verifyPack(other, { packId: "pack-0000001" }).ok).toBe(false);
  });

  it("refuse nesting deep enough to overflow the stack", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 5000; i++) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(/nested too deeply/);
  });

  it("refuse an Arweave data item of any broken shape", () => {
    const r = rng(41);
    for (let i = 0; i < FUZZ_RUNS; i++) settles("parseDataItem", () => parseDataItem(bytes(r, 2048)));
  });
});

describe("sealed and encrypted data", () => {
  it("never opens with a random box or a random key, and fails in one plain way", async () => {
    const r = rng(43);
    const key = await importKey(newVaultKey());
    const pair = newBoxKeyPair();
    for (let i = 0; i < FUZZ_RUNS; i++) {
      const s = r() < 0.3 ? `v1.${str(r, 40)}` : r() < 0.5 ? `s1.${Buffer.from(bytes(r, 120)).toString("base64url")}` : str(r, 80);
      await settlesAsync("decryptBytes", () => decryptBytes(key, s, "aad"));
      settles("openSealedJson", () => openSealedJson(pair, s, "context"));
      settles("openAskMessage", () => openAskMessage(bytes(r, 32).length === 32 ? new Uint8Array(32) : new Uint8Array(32), { linkId: "l", sessionId: "s", messageId: "m" }, "q", `r1.${Buffer.from(bytes(r, 24)).toString("base64url")}.${Buffer.from(bytes(r, 60)).toString("base64url")}`));
      const opened = await outcomeAsync(() => decryptBytes(key, s, "aad"));
      expect(opened.ok).toBe(false);
    }
  });
});

describe("cleaners of settings and requests", () => {
  it("turn any value into a safe one without throwing a crash", () => {
    const r = rng(47);
    for (let i = 0; i < FUZZ_RUNS; i++) {
      const v = json(r);
      for (const [label, fn] of [
        ["cleanRules", () => cleanRules(v)],
        ["cleanAgentRules", () => cleanAgentRules(v)],
        ["cleanQuestion", () => cleanQuestion(v)],
        ["cleanCard", () => cleanCard(v)],
        ["cleanGuard", () => cleanGuard(v)],
        ["cleanOffer", () => cleanOffer(v)],
        ["cleanSyncState", () => cleanSyncState(v)],
        ["cleanWalletRules", () => cleanWalletRules(v)],
        ["cleanBackup", () => cleanBackup(v)],
        ["cleanTarget", () => cleanTarget(v)],
        ["cleanMove", () => cleanMove(v)],
      ] as const) {
        settles(label, fn);
      }
    }
  });
});
