// A model of you: what Sigil learns about the owner, on the owner's device.
//
// Two parts, both kept in one setting encrypted under the vault key:
//
//   Lessons   plain sentences about how the owner writes, what matters most to
//             them and what they will not do, written by a model from the
//             folders the owner chose. Each lesson names the memories it came
//             from, and a lesson the owner removes never comes back.
//   Ranker    a small model trained in the browser on the owner's own choices
//             ("which of these two matters more to you?"), so it ranks memories
//             the way the owner does. Its weights are a few kilobytes.
//
// Every change keeps a snapshot, so one lesson can be removed and the whole
// model can be rolled back to a date. The score is how often the ranker
// predicts a choice it was not trained on.

import { fromBase64Url, toBase64Url } from "./encoding";
import type { ModelMessage } from "./model";
import { tokenize } from "./search";

export type LessonKind = "style" | "priority" | "limit";

export const LESSON_KINDS: readonly LessonKind[] = ["style", "priority", "limit"];

export const LESSON_KIND_NAME: Record<LessonKind, string> = { style: "How you write", priority: "What matters most to you", limit: "Your limits" };

export interface YouLesson {
  id: string;
  kind: LessonKind;
  text: string;
  /** The memories it came from. */
  sources: string[];
  at: string;
}

/** One answer to "which matters more to you?": the memory picked and the one passed over. */
export interface YouChoice {
  win: string;
  lose: string;
  at: string;
}

export interface YouRanker {
  dim: number;
  /** Float32 weights, base64url. */
  weights: string;
  trainedOn: number;
  at: string;
}

export interface YouScore {
  /** 0 to 100: the share of held-back choices the ranker predicted. */
  value: number;
  tested: number;
  at: string;
}

export interface YouSnapshot {
  at: string;
  reason: string;
  lessons: YouLesson[];
  ranker: YouRanker | null;
  score: YouScore | null;
  choices: number;
}

export interface YouState {
  v: 1;
  /** The folders it may learn from. */
  folders: string[];
  lessons: YouLesson[];
  /** Lessons the owner removed, in a normal form, so learning again does not bring them back. */
  dropped: string[];
  choices: YouChoice[];
  ranker: YouRanker | null;
  score: YouScore | null;
  history: YouSnapshot[];
  /** Write the lessons into the Self card folder, where apps given that folder read them. */
  shareWithApps: boolean;
  /** When the lessons were last learned, and from how many memories. */
  learnedAt: string | null;
  learnedFrom: number;
  updatedAt: string | null;
}

export const YOU_DIM = 512;
export const YOU_MAX_LESSONS = 24;
export const YOU_MAX_CHOICES = 1000;
export const YOU_MAX_HISTORY = 30;
/** Choices needed before the ranker is trained and scored. */
export const YOU_MIN_CHOICES = 10;
/** The most memories one round of learning reads. */
export const YOU_LEARN_MEMORIES = 60;

export function emptyYou(): YouState {
  return { v: 1, folders: [], lessons: [], dropped: [], choices: [], ranker: null, score: null, history: [], shareWithApps: false, learnedAt: null, learnedFrom: 0, updatedAt: null };
}

const isStr = (v: unknown): v is string => typeof v === "string";
const strList = (v: unknown, max: number, len = 64) => (Array.isArray(v) ? v.filter(isStr).map((s) => s.slice(0, len)).slice(0, max) : []);

function cleanLessonItem(v: unknown): YouLesson | null {
  const l = v as Partial<YouLesson> | null;
  if (!l || !isStr(l.id) || !isStr(l.text) || !LESSON_KINDS.includes(l.kind as LessonKind)) return null;
  const text = l.text.trim().slice(0, 240);
  if (!text) return null;
  return { id: l.id.slice(0, 64), kind: l.kind as LessonKind, text, sources: strList(l.sources, 12), at: isStr(l.at) ? l.at : new Date(0).toISOString() };
}

function cleanRanker(v: unknown): YouRanker | null {
  const r = v as Partial<YouRanker> | null;
  if (!r || typeof r.dim !== "number" || !isStr(r.weights) || !isStr(r.at)) return null;
  return { dim: r.dim, weights: r.weights, trainedOn: Number(r.trainedOn) || 0, at: r.at };
}

function cleanScore(v: unknown): YouScore | null {
  const s = v as Partial<YouScore> | null;
  if (!s || typeof s.value !== "number" || !isStr(s.at)) return null;
  return { value: Math.max(0, Math.min(100, Math.round(s.value))), tested: Number(s.tested) || 0, at: s.at };
}

/** Whatever was stored, as a state the vault can use. */
export function cleanYou(v: unknown): YouState {
  const s = (v ?? {}) as Partial<YouState>;
  const base = emptyYou();
  if (!s || typeof s !== "object") return base;
  const lessons = (Array.isArray(s.lessons) ? s.lessons : []).map(cleanLessonItem).filter((l): l is YouLesson => !!l).slice(0, YOU_MAX_LESSONS);
  const choices = (Array.isArray(s.choices) ? s.choices : [])
    .filter((c): c is YouChoice => !!c && isStr((c as YouChoice).win) && isStr((c as YouChoice).lose))
    .map((c) => ({ win: c.win.slice(0, 64), lose: c.lose.slice(0, 64), at: isStr(c.at) ? c.at : new Date(0).toISOString() }))
    .slice(-YOU_MAX_CHOICES);
  const history = (Array.isArray(s.history) ? s.history : [])
    .map((h) => {
      const x = h as Partial<YouSnapshot>;
      if (!x || !isStr(x.at)) return null;
      return {
        at: x.at,
        reason: isStr(x.reason) ? x.reason.slice(0, 120) : "",
        lessons: (Array.isArray(x.lessons) ? x.lessons : []).map(cleanLessonItem).filter((l): l is YouLesson => !!l).slice(0, YOU_MAX_LESSONS),
        ranker: cleanRanker(x.ranker),
        score: cleanScore(x.score),
        choices: Number(x.choices) || 0,
      };
    })
    .filter((h): h is YouSnapshot => !!h)
    .slice(-YOU_MAX_HISTORY);
  return {
    ...base,
    folders: strList(s.folders, 500),
    lessons,
    dropped: strList(s.dropped, 500, 240),
    choices,
    ranker: cleanRanker(s.ranker),
    score: cleanScore(s.score),
    history,
    shareWithApps: s.shareWithApps === true,
    learnedAt: isStr(s.learnedAt) ? s.learnedAt : null,
    learnedFrom: Number(s.learnedFrom) || 0,
    updatedAt: isStr(s.updatedAt) ? s.updatedAt : null,
  };
}

/** The state with a snapshot of it added to the history, for rolling back later. */
export function withSnapshot(s: YouState, reason: string, at = new Date()): YouState {
  const iso = at.toISOString();
  const snap: YouSnapshot = { at: iso, reason, lessons: s.lessons, ranker: s.ranker, score: s.score, choices: s.choices.length };
  return { ...s, history: [...s.history, snap].slice(-YOU_MAX_HISTORY), updatedAt: iso };
}

/** Puts the model back as it was at a snapshot. Choices made after it are let go, so the ranker and its data match. */
export function rollBack(s: YouState, snapshotAt: string, at = new Date()): YouState {
  const snap = s.history.find((h) => h.at === snapshotAt);
  if (!snap) throw new Error("That point in the history was not found.");
  const back: YouState = { ...s, lessons: snap.lessons, ranker: snap.ranker, score: snap.score, choices: s.choices.slice(0, snap.choices) };
  return withSnapshot(back, `Rolled back to ${snapshotAt.slice(0, 10)}`, at);
}

const normal = (text: string) => tokenize(text).join(" ");

/** Removes one lesson for good: learning again will not write it back. */
export function dropLesson(s: YouState, lessonId: string, at = new Date()): YouState {
  const lesson = s.lessons.find((l) => l.id === lessonId);
  if (!lesson) return s;
  const next: YouState = { ...s, lessons: s.lessons.filter((l) => l.id !== lessonId), dropped: [...s.dropped, normal(lesson.text)].slice(-500) };
  return withSnapshot(next, "Removed a lesson", at);
}

// ---------------------------------------------------------------- lessons

export interface LessonSource {
  id: string;
  title: string;
  folder: string;
  body: string;
  editedAt: string;
}

/** The memories one round of learning reads: the most recently edited, up to the limit, each cut short. */
export function lessonSources<T extends LessonSource>(memories: T[], limit = YOU_LEARN_MEMORIES): T[] {
  return [...memories].sort((a, b) => (a.editedAt < b.editedAt ? 1 : a.editedAt > b.editedAt ? -1 : a.id < b.id ? -1 : 1)).slice(0, limit);
}

const attr = (s: string) => s.replace(/[<>"\n]/g, " ").slice(0, 160);

export function youLessonPrompt(sources: LessonSource[], existing: YouLesson[]): { system: string; messages: ModelMessage[]; maxTokens: number } {
  const blocks = sources.map((m, i) => `<memory n="${i + 1}" title="${attr(m.title)}" folder="${attr(m.folder)}">\n${m.body.slice(0, 700)}\n</memory>`);
  const known = existing.length ? `\n\nLessons already written (keep the ones the memories still show, word them the same):\n${existing.map((l) => `${l.kind} | ${l.text}`).join("\n")}` : "";
  return {
    system: [
      "You read a person's own memories and write down what they show about that person, as lessons a model can follow to write and decide the way they do.",
      "Three kinds:",
      "- style: how they write (length, tone, words they use or avoid, greetings).",
      "- priority: what matters most to them and how they choose between things.",
      "- limit: what they will not do or accept.",
      "Rules:",
      "- Between 3 and 18 lessons. Only what the memories clearly show; fewer is better than guessing.",
      "- Each lesson is one short plain sentence about the person without a subject, for example 'Writes short and never uses emojis.' or 'Puts family before work on Sundays.'",
      "- Describe the person; never copy private details such as names of other people, addresses, numbers, accounts or health details.",
      "- Cite the memories each lesson comes from by their n.",
      "- Write one lesson per line, exactly: kind | lesson | n, n",
      "- Write only the lines.",
    ].join("\n"),
    messages: [{ role: "user", content: `${blocks.join("\n\n")}${known}` }],
    maxTokens: 1500,
  };
}

const LINE = /^\s*[-*]?\s*(style|priority|priorities|limit|limits)\s*\|\s*(.+?)\s*\|\s*([\d,\s]+)\s*$/i;

/** The model's lines as lessons: unknown kinds, lessons without a source and removed lessons are left out. */
export function parseYouLessons(text: string, sources: { id: string }[], dropped: string[], newId: () => string, at = new Date()): YouLesson[] {
  const gone = new Set(dropped);
  const seen = new Set<string>();
  const out: YouLesson[] = [];
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const kind = (m[1].toLowerCase().startsWith("prior") ? "priority" : m[1].toLowerCase().startsWith("limit") ? "limit" : "style") as LessonKind;
    const lesson = m[2].replace(/\s+/g, " ").trim().slice(0, 240);
    const key = normal(lesson);
    if (!key || gone.has(key) || seen.has(key)) continue;
    const ids = [...new Set(m[3].split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= sources.length))].map((n) => sources[n - 1].id);
    if (!ids.length) continue;
    seen.add(key);
    out.push({ id: newId(), kind, text: lesson, sources: ids.slice(0, 12), at: at.toISOString() });
    if (out.length >= YOU_MAX_LESSONS) break;
  }
  return out;
}

/** The lessons as plain text: for the AI self's prompt and for the memory apps read. */
export function lessonsText(lessons: YouLesson[]): string {
  return LESSON_KINDS.map((k) => {
    const ls = lessons.filter((l) => l.kind === k);
    return ls.length ? `${LESSON_KIND_NAME[k]}:\n${ls.map((l) => `- ${l.text}`).join("\n")}` : "";
  })
    .filter(Boolean)
    .join("\n\n");
}

export const YOU_MEMORY_TITLE = "A model of you";

/** The body of the memory apps read, written in the Self card folder when the owner shares the lessons. */
export function youMemoryBody(s: Pick<YouState, "lessons" | "score" | "learnedAt">): string {
  const head = "What Sigil learned about me from my own memories. Write and decide the way these lessons say.";
  const score = s.score ? `\n\nHow well it knows me: ${s.score.value} of 100.` : "";
  return `${head}\n\n${lessonsText(s.lessons)}${score}`;
}

// ---------------------------------------------------------------- the ranker, trained on the device

function hash(token: string): number {
  // FNV-1a, 32 bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A memory as numbers: its words hashed into a fixed number of slots, signed, and scaled to unit length. */
export function youFeatures(item: { title: string; tags?: string[]; body: string }, dim = YOU_DIM): Float32Array {
  const v = new Float32Array(dim);
  const words = tokenize(`${item.title} ${item.title} ${(item.tags ?? []).join(" ")} ${item.body.slice(0, 4000)}`);
  for (let i = 0; i < words.length; i++) {
    const h = hash(words[i]);
    v[h % dim] += h & 0x80000000 ? -1 : 1;
    if (i + 1 < words.length) {
      const b = hash(`${words[i]} ${words[i + 1]}`);
      v[b % dim] += (b & 0x80000000 ? -1 : 1) * 0.5;
    }
  }
  let n = 0;
  for (let i = 0; i < dim; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

export interface TrainPair {
  win: Float32Array;
  lose: Float32Array;
}

/** Pairwise logistic training: the weights learn to score the picked memory above the other. Deterministic. */
export function trainRanker(pairs: TrainPair[], dim = YOU_DIM, epochs = 80): Float32Array {
  const w = new Float32Array(dim);
  if (!pairs.length) return w;
  const diffs = pairs.map((p) => {
    const d = new Float32Array(dim);
    for (let i = 0; i < dim; i++) d[i] = p.win[i] - p.lose[i];
    return d;
  });
  const l2 = 1e-3;
  for (let e = 0; e < epochs; e++) {
    const rate = 0.6 / (1 + e * 0.05);
    for (let k = 0; k < diffs.length; k++) {
      const d = diffs[(k * 7 + e) % diffs.length];
      let s = 0;
      for (let i = 0; i < dim; i++) s += w[i] * d[i];
      const g = 1 / (1 + Math.exp(s)); // how wrong it still is
      for (let i = 0; i < dim; i++) w[i] += rate * (g * d[i] - l2 * w[i]);
    }
  }
  return w;
}

export function rankScore(weights: Float32Array, features: Float32Array): number {
  let s = 0;
  const n = Math.min(weights.length, features.length);
  for (let i = 0; i < n; i++) s += weights[i] * features[i];
  return s;
}

export function packWeights(w: Float32Array): string {
  return toBase64Url(new Uint8Array(w.buffer, w.byteOffset, w.byteLength));
}

export function unpackWeights(s: string): Float32Array {
  const bytes = fromBase64Url(s);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.length / 4));
}

/**
 * Trains on the owner's choices. Every fifth choice is held back first and the
 * ranker trained without them is scored on them; then the ranker is trained on
 * all of them. Choices whose memories are gone are left out.
 */
export function trainYou(s: YouState, features: Map<string, Float32Array>, at = new Date()): YouState {
  const usable = s.choices.filter((c) => features.has(c.win) && features.has(c.lose));
  if (usable.length < YOU_MIN_CHOICES) throw new Error(`Make at least ${YOU_MIN_CHOICES} choices first. ${usable.length} so far.`);
  const pair = (c: YouChoice): TrainPair => ({ win: features.get(c.win)!, lose: features.get(c.lose)! });
  const held = usable.filter((_, i) => i % 5 === 4);
  const train = usable.filter((_, i) => i % 5 !== 4);
  const trial = trainRanker(train.map(pair));
  const right = held.filter((c) => rankScore(trial, features.get(c.win)!) > rankScore(trial, features.get(c.lose)!)).length;
  const iso = at.toISOString();
  const weights = trainRanker(usable.map(pair));
  const next: YouState = {
    ...s,
    ranker: { dim: YOU_DIM, weights: packWeights(weights), trainedOn: usable.length, at: iso },
    score: { value: held.length ? Math.round((100 * right) / held.length) : 0, tested: held.length, at: iso },
  };
  return withSnapshot(next, `Trained on ${usable.length} choices`, at);
}

/** Orders items the way the ranker would, highest first; unchanged when there is no ranker. */
export function rankLikeYou<T extends { id: string; title: string; tags?: string[]; body: string }>(s: Pick<YouState, "ranker">, items: T[]): T[] {
  if (!s.ranker) return items;
  const w = unpackWeights(s.ranker.weights);
  const scored = items.map((it, i) => ({ it, i, s: rankScore(w, youFeatures(it, s.ranker!.dim)) }));
  return scored.sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.it);
}

/**
 * Two memories to choose between: drawn from the folders it learns from, never
 * a pair already answered, seeded so a test can repeat it.
 */
export function nextPair<T extends { id: string }>(items: T[], choices: YouChoice[], seed: number): [T, T] | null {
  if (items.length < 2) return null;
  const asked = new Set(choices.map((c) => [c.win, c.lose].sort().join("|")));
  let x = seed >>> 0 || 1;
  const rnd = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
  for (let tries = 0; tries < 200; tries++) {
    const a = items[Math.floor(rnd() * items.length)];
    const b = items[Math.floor(rnd() * items.length)];
    if (a.id === b.id || asked.has([a.id, b.id].sort().join("|"))) continue;
    return [a, b];
  }
  return null;
}
