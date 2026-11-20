import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HeadInfo, ProposalDraft } from "@sigil/core";
import { ObsidianWatcher, PER_PASS } from "../src/watch";
import type { VaultReader } from "../src/reader";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function vault(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "sigil-obsidian-"));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

/** Stands in for the connector's reader: records suggestions, and knows the notes the vault already holds. */
function reader(heads: Partial<HeadInfo>[] = []) {
  const proposed: ProposalDraft[] = [];
  const r = {
    appId: "app12345678",
    heads: async () => heads as HeadInfo[],
    propose: async (d: ProposalDraft) => (proposed.push(d), { id: "p" }),
  };
  return { proposed, reader: r as unknown as VaultReader };
}

describe("keeping an Obsidian vault in sync", () => {
  it("suggests new notes with their path, skips settings, and suggests a note again only when it changes", async () => {
    const root = vault({ "Daily/Mon.md": "#journal Rowed 5 km.", ".obsidian/app.json": "{}", "Empty.md": "" });
    const state = path.join(root, "..", `${path.basename(root)}-state.json`);
    dirs.push(state);
    const { proposed, reader: r } = reader();
    const w = new ObsidianWatcher(r, root, { stateFile: state });
    expect((await w.scan()).proposed).toEqual(["Daily/Mon.md"]);
    expect(proposed[0]).toEqual({ title: "Mon", body: "#journal Rowed 5 km.", tags: ["obsidian", "journal"], folder: "Obsidian", source: { kind: "obsidian", ref: "Daily/Mon.md" } });
    expect((await w.scan()).proposed).toEqual([]);

    writeFileSync(path.join(root, "Daily/Mon.md"), "#journal Rowed 7 km.");
    expect((await w.scan()).proposed).toEqual(["Daily/Mon.md"]);
    expect(proposed[1].body).toBe("#journal Rowed 7 km.");

    // A new watcher on the same folder remembers what was sent.
    const again = new ObsidianWatcher(r, root, { stateFile: state });
    expect((await again.scan()).proposed).toEqual([]);
  });

  it("on its first run, leaves out notes the vault already holds unchanged, and paces large folders", async () => {
    const files: Record<string, string> = { "Known.md": "Already imported." };
    for (let i = 0; i < PER_PASS + 3; i++) files[`New ${i}.md`] = `Note ${i}`;
    const root = vault(files);
    const old = new Date("2026-01-01T00:00:00Z");
    utimesSync(path.join(root, "Known.md"), old, old);
    const state = path.join(root, "..", `${path.basename(root)}-state.json`);
    dirs.push(state);
    const { proposed, reader: r } = reader([{ id: "m1", source: { kind: "obsidian", ref: "Known.md" }, editedAt: "2026-02-01T00:00:00.000Z" }]);
    const w = new ObsidianWatcher(r, root, { stateFile: state });
    const first = await w.scan();
    expect(first.proposed).toHaveLength(PER_PASS);
    expect(first.waiting).toBe(3);
    expect(proposed.some((p) => p.title === "Known")).toBe(false);
    expect((await w.scan()).proposed).toHaveLength(3);
  });
});
