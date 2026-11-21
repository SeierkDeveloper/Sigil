// A big vault for the performance check and for looking at by hand: by default
// 100,000 memories over five years in 40 folders, 12 connected apps and 200,000
// read-log entries, all made through the same code as the real vault (every
// memory encrypted with its folder key). Deterministic, so runs compare.

import { tx } from "../src/server/db";
import { logRead } from "../src/server/store";
import type { Harness } from "../test/helpers";
import { signedUp } from "../test/helpers";
import * as ops from "../src/vault/ops";
import type { MemoryDraft, SourceKind } from "@sigil/core";

const TOPICS = ["Garden", "Work", "Travel", "Health", "Recipes", "Books", "Family", "Money", "Music", "Running", "Car", "House", "Ideas", "Meetings", "Friends", "School", "Taxes", "Projects", "Films", "Language"];
const WORDS = "the a plan note call meeting tomatoes harbour invoice train flight recipe bread starter chapter friend sister brother doctor appointment budget saving loan song guitar marathon pace tyre service roof paint idea sketch draft review lesson class form deadline launch release design budget weekend holiday museum river mountain coffee tea dinner lunch market garden seeds soil rain sun".split(" ");
const KINDS: SourceKind[] = ["chatgpt", "claude", "note", "gmail", "calendar", "obsidian"];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeedOptions {
  memories?: number;
  folders?: number;
  apps?: number;
  log?: number;
  years?: number;
  onProgress?: (what: string, done: number, total: number) => void;
}

export function drafts(n: number, years = 5, seed = 1): MemoryDraft[] {
  const r = rng(seed);
  const pick = <T,>(l: T[]) => l[Math.floor(r() * l.length)];
  const end = Date.parse("2026-11-01T00:00:00Z");
  const span = years * 365 * 86_400_000;
  const out: MemoryDraft[] = [];
  for (let i = 0; i < n; i++) {
    const words: string[] = [];
    const len = 60 + Math.floor(r() * 80);
    for (let w = 0; w < len; w++) words.push(pick(WORDS));
    const at = new Date(end - Math.floor(r() * span)).toISOString();
    const kind = pick(KINDS);
    out.push({
      title: `${pick(TOPICS)}: ${pick(WORDS)} ${pick(WORDS)} ${i}`,
      body: words.join(" "),
      tags: r() < 0.5 ? [pick(TOPICS).toLowerCase()] : [],
      source: { kind, ref: `${kind}-${i}` },
      createdAt: at,
      editedAt: at,
    });
  }
  return out;
}

export async function seedVault(h: Harness, opts: SeedOptions = {}) {
  const n = opts.memories ?? 100_000;
  const nFolders = opts.folders ?? 40;
  const progress = opts.onProgress ?? (() => undefined);
  const s = await signedUp(h);
  const folders = [s.data.folders[0]];
  for (let i = 1; i < nFolders; i++) folders.push(await ops.addFolder(s.b.api, s.vault, `${TOPICS[i % TOPICS.length]} ${Math.floor(i / TOPICS.length) + 1}`));
  const all = drafts(n, opts.years ?? 5);
  const per = Math.ceil(n / folders.length);
  for (let f = 0; f < folders.length; f++) {
    const part = all.slice(f * per, (f + 1) * per);
    if (part.length) await ops.importDrafts(s.b.api, folders[f], part);
    progress("memories", Math.min(n, (f + 1) * per), n);
  }
  const appIds: string[] = [];
  for (let i = 0; i < (opts.apps ?? 12); i++) {
    const app = await ops.connectApp(s.b.api, s.vault, { name: `App ${i + 1}`, kind: "claude-desktop" }, folders.slice(i % folders.length, (i % folders.length) + 5));
    appIds.push(app.appId);
  }
  const userId = String((h.db.prepare("SELECT user_id FROM keyslots LIMIT 1").get() as { user_id: string }).user_id);
  const logN = opts.log ?? 200_000;
  const r = rng(7);
  const end = Date.now() - 2 * 3600_000;
  const memoryIds = (h.db.prepare("SELECT id FROM memories WHERE user_id = ? LIMIT 5000").all(userId) as { id: string }[]).map((m) => m.id);
  const chunk = 20_000;
  for (let i = 0; i < logN; i += chunk) {
    tx(h.db, () => {
      for (let j = i; j < Math.min(logN, i + chunk); j++) {
        const at = new Date(end - Math.floor(r() * 2 * 365 * 86_400_000));
        logRead(h.db, { appId: appIds[j % appIds.length], userId }, r() < 0.7 ? "read" : "index", r() < 0.7 ? memoryIds[j % memoryIds.length] : null, 1, at);
      }
    });
    progress("log", Math.min(logN, i + chunk), logN);
  }
  return { ...s, folders, appIds, userId };
}
