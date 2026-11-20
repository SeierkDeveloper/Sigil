import { describe, expect, it } from "vitest";
import { buildMemory, isHandle, privacyScore, publicCopy, publicCopyHash, publicMemories, type Memory } from "../src";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const day = (n: number, h = 10) => new Date(NOW - n * 86_400_000 + h * 3_600_000 - 12 * 3_600_000).toISOString();

describe("privacy score", () => {
  const folders = [
    { id: "work", name: "Work" },
    { id: "health", name: "Health", protect: "health" },
    { id: "notes", name: "Notes" },
  ];
  const memoryFolder = new Map([
    ["w1", "work"],
    ["w2", "work"],
    ["h1", "health"],
    ["n1", "notes"],
  ]);

  it("is 100 and quiet with nothing in the log", () => {
    const s = privacyScore({ entries: [], memoryFolder, folders, readable: 10, now: NOW });
    expect(s.score).toBe(100);
    expect(s.level).toBe("quiet");
    expect(s.parts.every((p) => p.points === 0)).toBe(true);
  });

  it("takes points for what the log shows, and says where each went", () => {
    const entries = [
      { kind: "index", memoryId: null, count: 4, at: day(1) },
      { kind: "read", memoryId: "w1", count: 1, at: day(1) },
      { kind: "read", memoryId: "w1", count: 1, at: day(2) },
      { kind: "read", memoryId: "w2", count: 1, at: day(2) },
      { kind: "protected", memoryId: "h1", count: 1, at: day(3) },
      { kind: "propose", memoryId: "p1", count: 1, at: day(3) },
      // Outside the window: not counted.
      { kind: "read", memoryId: "n1", count: 1, at: day(45) },
    ];
    const s = privacyScore({ entries, memoryFolder, folders, readable: 4, now: NOW });
    expect(s.facts).toMatchObject({ reads: 4, distinctMemories: 3, protectedReads: 1, writes: 1, activeDays: 3, searches: 1 });
    expect(s.facts.folders.map((f) => f.name)).toEqual(["Work", "Health"]);
    const points = Object.fromEntries(s.parts.map((p) => [p.key, p.points]));
    expect(points).toEqual({ reads: 23, folders: 10, protected: 10, often: 2, writes: 1 });
    expect(s.score).toBe(100 - 23 - 10 - 10 - 2 - 1);
    expect(s.level).toBe("regular");
    expect(s.facts.lastAt).toBe(day(1));
  });

  it("caps each part", () => {
    const entries = Array.from({ length: 120 }, (_, i) => ({ kind: i % 2 ? "protected" : "remember", memoryId: `h${i}`, count: 1, at: day(i % 30) }));
    const s = privacyScore({ entries, memoryFolder: new Map(entries.map((e) => [e.memoryId, "health"])), folders, readable: 1, now: NOW });
    const max = Object.fromEntries(s.parts.map((p) => [p.key, p.points === p.max]));
    expect(max).toMatchObject({ reads: true, protected: true, often: true, writes: true });
    expect(s.level).toBe("heavy");
  });
});

describe("public copy", () => {
  const mem = (folderId: string, title: string, body: string, extra: Partial<Memory> = {}): Memory => ({ ...buildMemory({ title, body }, folderId), ...extra });
  const folders = [
    { id: "pub", redact: ["email" as const] },
    { id: "priv" },
    { id: "health", protect: "health" as const },
  ];

  it("holds only the folders made public, never a protected one, masked with the folder's rules", () => {
    const items = publicCopy(
      [
        mem("pub", "Talks", "I speak about memory. Mail sam@example.org"),
        mem("priv", "Diary", "CANARY-private"),
        mem("health", "Blood test", "CANARY-health"),
        mem("pub", "Old", "gone", { expiresAt: "2020-01-01T00:00:00.000Z" }),
        mem("pub", "Self card", "card", { source: { kind: "profile" } }),
      ],
      folders,
      ["pub", "health"],
    );
    expect(items.map((i) => i.title)).toEqual(["Talks"]);
    expect(items[0].body).toBe("I speak about memory. Mail [email hidden]");
    expect(JSON.stringify(items)).not.toContain("CANARY");
    expect(publicMemories(items)[0]).toMatchObject({ folderId: "public", title: "Talks" });
    const h = publicCopyHash(items);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(publicCopyHash([{ ...items[0], body: "changed" }])).not.toBe(h);
  });

  it("accepts handles of 3 to 30 plain characters, not reserved words", () => {
    expect(isHandle("sam")).toBe(true);
    expect(isHandle("sam_writes-2")).toBe(true);
    expect(isHandle("ab")).toBe(false);
    expect(isHandle("Sam")).toBe(false);
    expect(isHandle("admin")).toBe(false);
    expect(isHandle("-sam")).toBe(false);
  });
});
