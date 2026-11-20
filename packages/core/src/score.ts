// A privacy score for each app and agent, made from the owner's own read log
// on the owner's device. It says how much an app has read, and nothing more:
// it cannot know what an app did with what it read, and it does not try to.
//
// The score starts at 100 and loses points for five things in the window
// (the last 30 days by default):
//
//   how much it read      up to 30  the share of the memories it may read that it read in full
//   how many folders      up to 20  5 for each folder it read from
//   protected reads       up to 25  10 for each read of a protected folder
//   how often             up to 15  the share of days in the window it was active
//   writes                up to 10  1 for every 5 suggestions, memories written or deleted
//
// 80 and above reads as light, 50 to 79 as regular, below 50 as heavy. The
// same numbers are shown next to the score, so the owner can see where every
// point went.

export interface ScoreEntry {
  kind: string;
  memoryId: string | null;
  count: number;
  at: string;
}

export interface ScoreInput {
  entries: ScoreEntry[];
  /** Which folder each memory is in, from the vault opened on this device. */
  memoryFolder: Map<string, string>;
  /** The vault's folders, by id. */
  folders: { id: string; name: string; protect?: string }[];
  /** How many memories the app may read now (in the folders granted to it). */
  readable: number;
  now?: number;
  windowDays?: number;
  /** True when the log held more entries than were looked at. */
  partial?: boolean;
}

export type ScoreLevel = "light" | "regular" | "heavy" | "quiet";

export interface ScorePart {
  key: "reads" | "folders" | "protected" | "often" | "writes";
  label: string;
  points: number;
  max: number;
  why: string;
}

export interface PrivacyScore {
  score: number;
  level: ScoreLevel;
  windowDays: number;
  facts: {
    reads: number;
    distinctMemories: number;
    searches: number;
    folders: { id: string; name: string; reads: number }[];
    protectedReads: number;
    writes: number;
    activeDays: number;
    lastAt: string | null;
    partial: boolean;
  };
  parts: ScorePart[];
}

const READ_KINDS = new Set(["read", "protected"]);
const WRITE_KINDS = new Set(["propose", "remember", "forget", "sync"]);
const SEARCH_KINDS = new Set(["index", "folders"]);

export const SCORE_WINDOW_DAYS = 30;

export const LEVEL_TEXT: Record<ScoreLevel, string> = {
  light: "Light reader",
  regular: "Regular reader",
  heavy: "Heavy reader",
  quiet: "Not active",
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function privacyScore(input: ScoreInput): PrivacyScore {
  const now = input.now ?? Date.now();
  const windowDays = input.windowDays ?? SCORE_WINDOW_DAYS;
  const since = now - windowDays * 86_400_000;
  const entries = input.entries.filter((e) => {
    const t = Date.parse(e.at);
    return Number.isFinite(t) && t >= since && t <= now + 60_000;
  });
  const folderName = new Map(input.folders.map((f) => [f.id, f.name]));

  let reads = 0;
  let protectedReads = 0;
  let writes = 0;
  let searches = 0;
  const distinct = new Set<string>();
  const perFolder = new Map<string, number>();
  const days = new Set<string>();
  let lastAt: string | null = null;
  for (const e of entries) {
    days.add(e.at.slice(0, 10));
    if (!lastAt || e.at > lastAt) lastAt = e.at;
    if (READ_KINDS.has(e.kind)) {
      reads++;
      if (e.kind === "protected") protectedReads++;
      if (e.memoryId) {
        distinct.add(e.memoryId);
        const f = input.memoryFolder.get(e.memoryId);
        if (f) perFolder.set(f, (perFolder.get(f) ?? 0) + 1);
      }
    } else if (WRITE_KINDS.has(e.kind)) {
      writes += Math.max(1, e.count || 1);
    } else if (SEARCH_KINDS.has(e.kind)) {
      searches++;
    }
  }

  const share = input.readable > 0 ? Math.min(1, distinct.size / input.readable) : distinct.size > 0 ? 1 : 0;
  const readPoints = Math.round(share * 30);
  const folderPoints = Math.min(20, perFolder.size * 5);
  const protectedPoints = Math.min(25, protectedReads * 10);
  const oftenPoints = Math.round((Math.min(days.size, windowDays) / windowDays) * 15);
  const writePoints = Math.min(10, Math.ceil(writes / 5));

  const parts: ScorePart[] = [
    {
      key: "reads",
      label: "How much it read",
      points: readPoints,
      max: 30,
      why: `${plural(distinct.size, "memory", "memories")} read in full, of ${plural(input.readable, "memory", "memories")} it may read.`,
    },
    {
      key: "folders",
      label: "Folders",
      points: folderPoints,
      max: 20,
      why: perFolder.size ? `Read from ${plural(perFolder.size, "folder")}.` : "Read from no folder.",
    },
    {
      key: "protected",
      label: "Protected reads",
      points: protectedPoints,
      max: 25,
      why: protectedReads ? `${plural(protectedReads, "read")} of protected folders, each one after your yes.` : "No read of a protected folder.",
    },
    {
      key: "often",
      label: "How often",
      points: oftenPoints,
      max: 15,
      why: `Active on ${plural(days.size, "day")} of the last ${windowDays}.`,
    },
    {
      key: "writes",
      label: "Writes",
      points: writePoints,
      max: 10,
      why: writes ? `${plural(writes, "suggestion or write", "suggestions and writes")}.` : "No suggestion or write.",
    },
  ];

  const score = Math.max(0, 100 - parts.reduce((s, p) => s + p.points, 0));
  const level: ScoreLevel = entries.length === 0 ? "quiet" : score >= 80 ? "light" : score >= 50 ? "regular" : "heavy";
  return {
    score,
    level,
    windowDays,
    facts: {
      reads,
      distinctMemories: distinct.size,
      searches,
      folders: [...perFolder.entries()].map(([id, n]) => ({ id, name: folderName.get(id) ?? "A deleted folder", reads: n })).sort((a, b) => b.reads - a.reads),
      protectedReads,
      writes,
      activeDays: days.size,
      lastAt,
      partial: input.partial === true,
    },
    parts,
  };
}
