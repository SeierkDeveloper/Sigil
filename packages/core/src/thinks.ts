// Memory that thinks, on the device: a weekly brief, memories that disagree,
// duplicate groups merged in one step, and memories that expire. Everything
// here works without a model; when the owner has set their own model key, the
// brief can be written by it and a possible contradiction can be checked by it.

import { tokenize, type Searchable } from "./search";
import { cosine, type DuplicatePair } from "./semantic";
import type { ModelCaller } from "./model";

const DAY = 86_400_000;

// ---------------------------------------------------------------- the weekly brief

export interface BriefMemory {
  id: string;
  title: string;
  folder: string;
  createdAt: string;
  editedAt: string;
  snippet: string;
  source: { kind: string };
}

export interface BriefFacts {
  from: string;
  to: string;
  added: BriefMemory[];
  changed: BriefMemory[];
  forgotten: BriefMemory[];
  total: number;
}

export interface BriefOptions {
  /** The window the brief covers, in days (7). */
  days?: number;
  /** A memory untouched this many days counts as forgotten (120). */
  forgottenDays?: number;
  /** At most this many lines per section (8). */
  limit?: number;
}

/** What is new, what changed and what was forgotten, from the dates the vault keeps. Briefs and the Self card are left out. */
export function briefFacts(memories: BriefMemory[], now = new Date(), opts: BriefOptions = {}): BriefFacts {
  const days = opts.days ?? 7;
  const limit = opts.limit ?? 8;
  const since = now.getTime() - days * DAY;
  const stale = now.getTime() - (opts.forgottenDays ?? 120) * DAY;
  const pool = memories.filter((m) => m.source.kind !== "brief" && m.source.kind !== "profile");
  const t = (iso: string) => new Date(iso).getTime();
  const newest = (a: BriefMemory, b: BriefMemory) => t(b.editedAt) - t(a.editedAt);
  return {
    from: new Date(since).toISOString(),
    to: now.toISOString(),
    added: pool.filter((m) => t(m.createdAt) >= since).sort(newest).slice(0, limit),
    changed: pool.filter((m) => t(m.createdAt) < since && t(m.editedAt) >= since).sort(newest).slice(0, limit),
    // The longest untouched first: the ones most likely to be out of date.
    forgotten: pool.filter((m) => t(m.editedAt) < stale).sort((a, b) => t(a.editedAt) - t(b.editedAt)).slice(0, limit),
    total: pool.length,
  };
}

const day = (iso: string) => iso.slice(0, 10);

export function briefTitle(facts: Pick<BriefFacts, "from" | "to">): string {
  return `Weekly brief, ${day(facts.from)} to ${day(facts.to)}`;
}

/** The brief written without a model: three plain lists. */
export function plainBrief(facts: BriefFacts): string {
  const line = (m: BriefMemory, when: string) => `- ${m.title} (${m.folder}, ${when} ${day(m.editedAt)})`;
  const parts: string[] = [];
  parts.push(
    `${facts.added.length + facts.changed.length === 0 ? "A quiet week" : "This week"} in a vault of ${facts.total} ${facts.total === 1 ? "memory" : "memories"}.`,
  );
  parts.push("## What is new", facts.added.length ? facts.added.map((m) => line(m, "added")).join("\n") : "Nothing new this week.");
  parts.push("## What changed", facts.changed.length ? facts.changed.map((m) => line(m, "edited")).join("\n") : "Nothing older was edited this week.");
  parts.push(
    "## What you may have forgotten",
    facts.forgotten.length
      ? `${facts.forgotten.map((m) => line(m, "last edited")).join("\n")}\n\nStill true? Edit them, or give them an expiry date.`
      : "Nothing has gone untouched for long.",
  );
  return parts.join("\n\n");
}

export function briefPrompt(facts: BriefFacts): { system: string; user: string } {
  const list = (items: BriefMemory[]) =>
    items.length ? items.map((m) => `- "${m.title}" in ${m.folder}, edited ${day(m.editedAt)}: ${m.snippet.slice(0, 200)}`).join("\n") : "(none)";
  return {
    system:
      "You write a short weekly brief of a person's own memory vault, addressed to them as 'you'. Use three headings exactly: '## What is new', '## What changed', '## What you may have forgotten'. Under each, a few plain sentences or bullets. Use only the items given. No preamble, no sign-off.",
    user: `Week ${day(facts.from)} to ${day(facts.to)}, ${facts.total} memories in all.\n\nNew:\n${list(facts.added)}\n\nChanged:\n${list(facts.changed)}\n\nUntouched for a long time:\n${list(facts.forgotten)}`,
  };
}

/** The brief's text: from the owner's model when one is given and it answers, otherwise the plain one. */
export async function writeBrief(facts: BriefFacts, model: ModelCaller | null): Promise<{ body: string; usedModel: boolean }> {
  if (model) {
    try {
      const p = briefPrompt(facts);
      const text = await model.complete({ system: p.system, messages: [{ role: "user", content: p.user }], maxTokens: 2000 });
      if (text.trim()) return { body: text.trim(), usedModel: true };
    } catch {
      // Fall back to the brief made without a model.
    }
  }
  return { body: plainBrief(facts), usedModel: false };
}

export const BRIEFS_FOLDER = "Briefs";

/** A new brief is due when there is none from the last seven days. */
export function briefDue(memories: { source: { kind: string }; createdAt: string }[], now = new Date()): boolean {
  const last = memories.filter((m) => m.source.kind === "brief").reduce((max, m) => Math.max(max, new Date(m.createdAt).getTime()), 0);
  return now.getTime() - last >= 7 * DAY;
}

// ---------------------------------------------------------------- contradictions

export interface ContradictionCandidate<T> {
  a: T;
  b: T;
  /** How close the two are in topic: cosine with vectors, word overlap without. */
  closeness: number;
  /** Why they may disagree, in plain words. */
  signals: string[];
}

const NEGATIONS = new Set(["not", "no", "never", "dont", "don't", "doesnt", "doesn't", "isnt", "isn't", "wont", "won't", "cant", "can't", "stopped", "quit", "without", "nor"]);
const OPPOSITES: [string, string][] = [
  ["love", "hate"],
  ["like", "dislike"],
  ["always", "never"],
  ["yes", "no"],
  ["vegan", "meat"],
  ["vegetarian", "meat"],
  ["morning", "evening"],
  ["early", "late"],
  ["start", "stop"],
  ["started", "stopped"],
  ["allowed", "forbidden"],
  ["true", "false"],
  ["more", "less"],
  ["prefer", "avoid"],
];

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[’]/g, "'")
      .split(/[^\p{L}\p{N}']+/u)
      .filter(Boolean),
  );
}

function numbers(text: string): Set<string> {
  return new Set([...text.matchAll(/\b\d+(?:[.,]\d+)?\b/g)].map((m) => m[0].replace(",", ".")));
}

/** Plain-word reasons two texts on the same topic may disagree. Empty when nothing stands out. */
export function disagreementSignals(a: string, b: string): string[] {
  const wa = words(a);
  const wb = words(b);
  const out: string[] = [];
  const negA = [...wa].some((w) => NEGATIONS.has(w));
  const negB = [...wb].some((w) => NEGATIONS.has(w));
  if (negA !== negB) out.push("One says no where the other says yes");
  for (const [x, y] of OPPOSITES) {
    if ((wa.has(x) && wb.has(y) && !wa.has(y)) || (wa.has(y) && wb.has(x) && !wa.has(x))) {
      out.push(`"${x}" against "${y}"`);
      break;
    }
  }
  const na = numbers(a);
  const nb = numbers(b);
  if (na.size && nb.size && ![...na].some((n) => nb.has(n))) out.push("Different numbers or dates");
  return out;
}

function overlap(a: string, b: string): number {
  const sa = new Set(tokenize(a).filter((t) => t.length > 2));
  const sb = new Set(tokenize(b).filter((t) => t.length > 2));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / Math.min(sa.size, sb.size);
}

export interface ContradictionOptions {
  vectors?: Map<string, Float32Array>;
  /** From this closeness two memories are about the same thing (0.6 with vectors, 0.5 word overlap without). */
  minCloseness?: number;
  /** At or above this closeness they are duplicates, not contradictions (0.97). */
  maxCloseness?: number;
  maxPairwise?: number;
}

const CONTRADICTION_TEXT = 2000;

/**
 * Pairs of memories about the same thing that may say different things: close
 * in meaning (or in words, without vectors) and with at least one sign of
 * disagreement. The owner, or the owner's model, decides.
 */
export function findContradictions<T extends Searchable>(items: T[], opts: ContradictionOptions = {}): ContradictionCandidate<T>[] {
  const recent = [...items].sort((a, b) => (a.editedAt < b.editedAt ? 1 : -1)).slice(0, opts.maxPairwise ?? 600);
  const max = opts.maxCloseness ?? 0.97;
  const out: ContradictionCandidate<T>[] = [];
  const texts = recent.map((m) => `${m.title}\n${m.text.slice(0, CONTRADICTION_TEXT)}`);
  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const va = opts.vectors?.get(recent[i].id);
      const vb = opts.vectors?.get(recent[j].id);
      const closeness = va && vb ? cosine(va, vb) : overlap(texts[i], texts[j]);
      const min = opts.minCloseness ?? (va && vb ? 0.6 : 0.5);
      if (closeness < min || closeness >= max) continue;
      if (texts[i].trim().toLowerCase() === texts[j].trim().toLowerCase()) continue;
      const signals = disagreementSignals(texts[i], texts[j]);
      if (signals.length) out.push({ a: recent[i], b: recent[j], closeness, signals });
    }
  }
  return out.sort((x, y) => y.signals.length - x.signals.length || y.closeness - x.closeness);
}

export interface ContradictionVerdict {
  contradicts: boolean;
  why: string;
}

/** Asks the owner's model whether two memories really disagree. */
export async function checkContradiction(model: ModelCaller, a: { title: string; text: string }, b: { title: string; text: string }): Promise<ContradictionVerdict> {
  const text = await model.complete({
    system:
      'You compare two notes from one person\'s memory vault. Reply with one line of JSON only: {"contradicts": true or false, "why": "one short sentence"}. They contradict only if both cannot be true at the same time.',
    messages: [{ role: "user", content: `Note A, "${a.title}":\n${a.text.slice(0, CONTRADICTION_TEXT)}\n\nNote B, "${b.title}":\n${b.text.slice(0, CONTRADICTION_TEXT)}` }],
    maxTokens: 400,
  });
  const m = /\{[\s\S]*\}/.exec(text);
  try {
    const v = JSON.parse(m ? m[0] : text) as { contradicts?: unknown; why?: unknown };
    return { contradicts: v.contradicts === true, why: String(v.why ?? "").slice(0, 300) };
  } catch {
    return { contradicts: false, why: "The model's answer could not be read." };
  }
}

// ---------------------------------------------------------------- duplicate groups

/** Joins duplicate pairs that share a memory into groups, so three copies become one group. */
export function groupDuplicates<T extends { id: string }>(pairs: DuplicatePair<T>[]): T[][] {
  const parent = new Map<string, string>();
  const items = new Map<string, T>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const p of pairs) {
    for (const m of [p.a, p.b]) {
      if (!parent.has(m.id)) parent.set(m.id, m.id);
      items.set(m.id, m);
    }
    const ra = find(p.a.id);
    const rb = find(p.b.id);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, T[]>();
  for (const id of items.keys()) {
    const r = find(id);
    groups.set(r, [...(groups.get(r) ?? []), items.get(id)!]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

export interface MergeableMemory {
  id: string;
  title: string;
  body: string;
  tags: string[];
  editedAt: string;
}

/** One memory from a group: the newest is kept, the others' text is added when it says more, the tags are joined. */
export function mergeGroup<T extends MergeableMemory>(group: T[]): { keep: T; body: string; tags: string[]; drop: T[] } {
  if (group.length < 2) throw new Error("A group needs two memories.");
  const sorted = [...group].sort((a, b) => (a.editedAt < b.editedAt ? 1 : -1));
  const [keep, ...drop] = sorted;
  let body = keep.body;
  for (const d of drop) {
    if (!body.includes(d.body.trim())) body = `${body.trimEnd()}\n\n---\n${d.title}\n\n${d.body.trim()}`;
  }
  return { keep, body, tags: [...new Set([...keep.tags, ...drop.flatMap((d) => d.tags)])], drop };
}

// ---------------------------------------------------------------- expiry

export function isExpired(m: { expiresAt?: string }, now = Date.now()): boolean {
  return !!m.expiresAt && new Date(m.expiresAt).getTime() <= now;
}

/** When the server deletes an expiring memory for real: its expiry plus the grace period. */
export function deleteAfter(expiresAt: string | undefined, graceDays: number): string | null {
  if (!expiresAt) return null;
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) ? new Date(t + graceDays * DAY).toISOString() : null;
}
