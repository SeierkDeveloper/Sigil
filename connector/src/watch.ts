// Keeps an Obsidian vault in sync through the inbox. The connector watches the
// folder on this machine; a new or changed note is sealed here, for the owner's
// vault only, and suggested to the inbox with its path. The vault offers to
// update the memory imported from the same note. Nothing changes in the vault
// without the owner's approval.
//
// What was already suggested is remembered in a small state file (a hash per
// note path, no text) so a note is suggested again only when it changes.

import { mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isObsidianNotePath, parseObsidianNote, sha256Hex } from "@sigil/core";
import type { VaultReader } from "./reader";

/** Suggestions sent in one pass. The server takes 10 a minute and 30 an hour from one app; the rest wait for the next pass. */
export const PER_PASS = 8;

export interface WatchOptions {
  /** The folder the owner suggests in the inbox. */
  folder?: string;
  stateFile?: string;
  log?: (line: string) => void;
}

export interface ScanResult {
  proposed: string[];
  unchanged: number;
  waiting: number;
}

function listNotes(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (isObsidianNotePath(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

export function defaultStateFile(appId: string, root: string): string {
  const dir = process.env.SIGIL_STATE_DIR?.trim() || path.join(homedir(), ".sigil-connector");
  return path.join(dir, `obsidian-${sha256Hex(`${appId}\n${path.resolve(root)}`).slice(0, 16)}.json`);
}

export class ObsidianWatcher {
  private readonly root: string;
  private readonly stateFile: string;
  private readonly folder: string;
  private readonly log: (line: string) => void;
  private state: Map<string, string> | null = null;
  private running: Promise<ScanResult> | null = null;
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly reader: VaultReader,
    root: string,
    opts: WatchOptions = {},
  ) {
    this.root = path.resolve(root);
    if (!statSync(this.root).isDirectory()) throw new Error(`${root} is not a folder.`);
    this.stateFile = opts.stateFile ?? defaultStateFile(reader.appId, this.root);
    this.folder = opts.folder ?? "Obsidian";
    this.log = opts.log ?? (() => undefined);
  }

  private loadState(): Map<string, string> | null {
    try {
      const data = JSON.parse(readFileSync(this.stateFile, "utf8")) as { notes?: Record<string, string> };
      return new Map(Object.entries(data.notes ?? {}));
    } catch {
      return null;
    }
  }

  private saveState(state: Map<string, string>): void {
    mkdirSync(path.dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify({ v: 1, notes: Object.fromEntries(state) }), { mode: 0o600 });
  }

  /** One pass over the folder: suggests new and changed notes, up to PER_PASS. */
  scan(): Promise<ScanResult> {
    if (!this.running) this.running = this.pass().finally(() => (this.running = null));
    return this.running;
  }

  private async pass(): Promise<ScanResult> {
    let state = this.state ?? this.loadState();
    const files = listNotes(this.root);
    if (!state) {
      // First run: notes the vault already holds, at least as new as the file, count as sent.
      state = new Map();
      let known = new Map<string, number>();
      try {
        const heads = await this.reader.heads();
        known = new Map(heads.filter((h) => h.source.kind === "obsidian" && h.source.ref).map((h) => [h.source.ref!, new Date(h.editedAt).getTime()]));
      } catch {
        // This app may not read the folder; every note is then suggested once.
      }
      for (const rel of files) {
        const edited = known.get(rel);
        const full = path.join(this.root, rel);
        if (edited !== undefined && statSync(full).mtimeMs <= edited + 1000) state.set(rel, sha256Hex(readFileSync(full)));
      }
    }
    this.state = state;
    const result: ScanResult = { proposed: [], unchanged: 0, waiting: 0 };
    for (const rel of files) {
      const full = path.join(this.root, rel);
      const bytes = readFileSync(full);
      const hash = sha256Hex(bytes);
      if (state.get(rel) === hash) {
        result.unchanged++;
        continue;
      }
      if (result.proposed.length >= PER_PASS) {
        result.waiting++;
        continue;
      }
      const draft = parseObsidianNote(rel, bytes.toString("utf8"), statSync(full).mtime.toISOString());
      if (!draft) {
        state.set(rel, hash);
        continue;
      }
      try {
        await this.reader.propose({ title: draft.title, body: draft.body, tags: draft.tags, folder: this.folder, source: { kind: "obsidian", ref: rel } });
        state.set(rel, hash);
        result.proposed.push(rel);
        this.log(`suggested ${rel}`);
      } catch (err) {
        this.log(`could not suggest ${rel}: ${(err as Error).message}`);
        result.waiting++;
        break;
      }
    }
    this.saveState(state);
    return result;
  }

  /** Watches the folder: a pass after changes settle, and one every minute for what had to wait. */
  start(everyMs = 60_000): void {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const kick = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void this.scan().catch((e) => this.log((e as Error).message)), 2000);
    };
    this.watcher = watch(this.root, { recursive: true }, kick);
    this.timer = setInterval(kick, everyMs);
    kick();
  }

  stop(): void {
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
  }
}
