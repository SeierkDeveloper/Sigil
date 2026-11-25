// An agent's own memory, on this machine. When the app key belongs to an
// agent, the connector also remembers, recalls, forgets and passes handoff
// notes. Memories are encrypted here with the key of a folder the agent may
// write (or a team space's key), notes with a key derived from the agent's own
// secret (or the space's key). The server checks the agent's rules and logs
// every call; it never sees a key or a word of what was written.

import {
  agentBoxPair,
  agentHandoffKey,
  appKeys,
  buildMemory,
  cleanHandoff,
  decryptMemory,
  encryptMemory,
  importKey,
  openFolderWithRaw,
  openGrant,
  openHandoff,
  openSpaceKey,
  openSpaceWithRaw,
  randomId,
  sealHandoff,
  spaceHandoffKey,
  versionHash,
  type MemoryPointer,
  type AgentRules,
  type HandoffNote,
  type Memory,
  type OpenFolder,
  type OpenSpace,
} from "@sigil/core";
import { ReaderError as ClientError, type VaultReader } from "./reader";

export interface AgentProfile {
  appId: string;
  homeFolderId: string;
  rules: AgentRules;
  writable: string[];
}

interface WireFolder {
  id: string;
  meta: string;
  wrappedKey: string;
  count: number;
  mode?: "read" | "write";
}

interface WireSpace {
  id: string;
  meta: string;
  epoch: number;
  me: { id: string; role: "read" | "write" | "admin"; sealedKey: string };
  members: { id: string; label: string; kind: string }[];
  memories: { id: string; folderId: string; head: string; body: string; author: string | null; updatedAt: string }[];
}

export interface OpenedSpace {
  space: OpenSpace;
  role: "read" | "write" | "admin";
  memories: Memory[];
}

export interface RecallHit {
  id: string;
  title: string;
  where: string;
  body: string;
  editedAt: string;
  tags: string[];
}

/** A pinned version of the agent's own folder: the pointer to keep, and the same as one string. */
export interface PinnedVersion extends MemoryPointer {
  pinnedAt: string;
  pointer: string;
}

/** The agent's folder as it was at a version, opened on this machine and checked against its fingerprint. */
export interface RestoredVersion {
  version: number;
  newest: number;
  hash: string;
  /** The fingerprint of what arrived, computed here, matched the server's (and the pinned one, when given). */
  verified: boolean;
  memories: RecallHit[];
}

export interface PickedNote extends HandoffNote {
  id: string;
  space: string | null;
}

/** What the MCP server needs from an agent. AgentMemory implements it; tests pass a stub. */
export interface AgentTools {
  remember(input: { title: string; body: string; tags?: string[]; folder?: string }): Promise<{ id: string; where: string }>;
  recall(query: string, opts?: { limit?: number }): Promise<RecallHit[]>;
  forget(ids: string[]): Promise<{ deleted: string[]; refused: string[] }>;
  leaveHandoff(input: { text: string; space?: string; to?: string }): Promise<{ id: string; where: string }>;
  pickUpHandoffs(): Promise<PickedNote[]>;
  pin(): Promise<PinnedVersion>;
  restore(version: number, expectHash?: string): Promise<RestoredVersion>;
}

export class AgentMemory implements AgentTools {
  /** The name notes and memories are signed with: the MCP client's name, when it gives one. */
  name: () => string = () => "An agent";

  constructor(private readonly reader: VaultReader) {}

  /** The agent record for this key, or null when the key belongs to an ordinary app. */
  static async detect(reader: VaultReader): Promise<AgentProfile | null> {
    try {
      return await reader.request<AgentProfile>("GET", "agent");
    } catch (err) {
      if (err instanceof ClientError && err.code === "not_agent") return null;
      throw err;
    }
  }

  private async folders(): Promise<{ folder: OpenFolder; mode: "read" | "write" }[]> {
    const r = await this.reader.request<{ folders: WireFolder[] }>("GET", "folders");
    const wrap = await importKey((await appKeys(this.reader.appSecret)).wrapKey);
    const out: { folder: OpenFolder; mode: "read" | "write" }[] = [];
    for (const f of r.folders) {
      const raw = await openGrant(this.reader.appId, wrap, { folderId: f.id, wrappedKey: f.wrappedKey });
      out.push({ folder: await openFolderWithRaw(f, raw), mode: f.mode === "write" ? "write" : "read" });
    }
    return out;
  }

  async spaces(): Promise<OpenedSpace[]> {
    const r = await this.reader.request<{ spaces: WireSpace[] }>("GET", "spaces");
    const pair = agentBoxPair(this.reader.appSecret);
    const out: OpenedSpace[] = [];
    for (const s of r.spaces) {
      try {
        const { raw } = openSpaceKey(pair, s.id, s.me.id, s.me.sealedKey);
        const space = await openSpaceWithRaw(s.id, s.meta, raw);
        const memories: Memory[] = [];
        for (const m of s.memories) memories.push(await decryptMemory(space, m));
        out.push({ space, role: s.me.role, memories });
      } catch {
        // A space whose key does not open with this agent's key is skipped.
      }
    }
    return out;
  }

  private match(name: string | undefined, candidates: { id: string; name: string }[]) {
    const want = name?.trim().toLowerCase();
    if (!want) return undefined;
    return candidates.find((c) => c.name.toLowerCase() === want || c.id === name);
  }

  async remember(input: { title: string; body: string; tags?: string[]; folder?: string }): Promise<{ id: string; where: string }> {
    const profile = await this.reader.request<AgentProfile>("GET", "agent");
    // The server refuses it too; saying so first keeps the reason plain.
    if (!profile.rules.remember) throw new ClientError("This agent may not remember things in the vault. The owner can allow it under Agents.", 403, "remember_off");
    if (input.folder) {
      const spaces = await this.spaces();
      const space = this.match(
        input.folder,
        spaces.map((s) => ({ id: s.space.id, name: s.space.name })),
      );
      if (space) {
        const s = spaces.find((x) => x.space.id === space.id)!;
        const memory = buildMemory({ title: input.title, body: input.body, tags: input.tags, source: { kind: "agent", ref: this.name() } }, s.space.id);
        await this.reader.request("POST", `spaces/${s.space.id}/memories`, { memories: [await encryptMemory(s.space, memory)] });
        return { id: memory.id, where: `the space ${s.space.name}` };
      }
    }
    const folders = await this.folders();
    const writable = folders.filter((f) => f.mode === "write");
    const target = input.folder
      ? this.match(
          input.folder,
          writable.map((f) => ({ id: f.folder.id, name: f.folder.name })),
        )
      : { id: profile.homeFolderId, name: "" };
    const folder = target ? writable.find((f) => f.folder.id === target.id)?.folder : undefined;
    if (!folder) {
      throw new ClientError(
        input.folder ? `This agent may not write "${input.folder}". It may write: ${writable.map((f) => f.folder.name).join(", ") || "nothing"}.` : "This agent's own folder is not available.",
        403,
        "read_only",
      );
    }
    const memory = buildMemory({ title: input.title, body: input.body, tags: input.tags, source: { kind: "agent", ref: this.name() } }, folder.id);
    await this.reader.request("POST", "remember", { memories: [await encryptMemory(folder, memory)] });
    return { id: memory.id, where: folder.name };
  }

  /** Searches its folders (by meaning and words, on this machine) and its spaces, and returns the best in full. */
  async recall(query: string, opts: { limit?: number } = {}): Promise<RecallHit[]> {
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);
    const hits = await this.reader.search(query, { limit });
    const { memories } = hits.length ? await this.reader.read(hits.map((h) => h.id)) : { memories: [] };
    const out: RecallHit[] = memories.map((m) => ({ id: m.id, title: m.title, where: m.folder, body: m.body, editedAt: m.editedAt, tags: m.tags }));
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    for (const s of await this.spaces()) {
      for (const m of s.memories) {
        const text = `${m.title} ${m.tags.join(" ")} ${m.body}`.toLowerCase();
        if (words.length === 0 || words.some((w) => text.includes(w))) out.push({ id: m.id, title: m.title, where: `the space ${s.space.name}`, body: m.body, editedAt: m.editedAt, tags: m.tags });
      }
    }
    return out.slice(0, limit * 2);
  }

  async forget(ids: string[]): Promise<{ deleted: string[]; refused: string[] }> {
    // Without recall the agent cannot see its spaces; it may still forget in its own folders.
    const spaces = await this.spaces().catch(() => [] as OpenedSpace[]);
    const deleted: string[] = [];
    const refused: string[] = [];
    const rest: string[] = [];
    for (const id of ids) {
      const s = spaces.find((x) => x.memories.some((m) => m.id === id));
      if (!s) {
        rest.push(id);
        continue;
      }
      try {
        await this.reader.request("POST", `spaces/${s.space.id}/forget`, { ids: [id] });
        deleted.push(id);
      } catch {
        refused.push(id);
      }
    }
    if (rest.length) {
      const r = await this.reader.request<{ deleted: string[]; refused: string[] }>("POST", "forget", { ids: rest });
      deleted.push(...r.deleted);
      refused.push(...r.refused);
    }
    return { deleted, refused };
  }

  async leaveHandoff(input: { text: string; space?: string; to?: string }): Promise<{ id: string; where: string }> {
    const id = randomId();
    const note = cleanHandoff({ from: this.name(), text: input.text, to: input.to ?? null });
    if (input.space) {
      const spaces = await this.spaces();
      const m = this.match(
        input.space,
        spaces.map((s) => ({ id: s.space.id, name: s.space.name })),
      );
      const s = m ? spaces.find((x) => x.space.id === m.id) : undefined;
      if (!s) throw new ClientError(`This agent is not in a space called "${input.space}".`, 404, "not_member");
      await this.reader.request("POST", "handoffs", { id, sealed: await sealHandoff(await spaceHandoffKey(s.space.raw), id, note), spaceId: s.space.id });
      return { id, where: `the space ${s.space.name}` };
    }
    await this.reader.request("POST", "handoffs", { id, sealed: await sealHandoff(await agentHandoffKey(this.reader.appSecret), id, note), spaceId: null });
    return { id, where: "this agent's next session" };
  }

  async pickUpHandoffs(): Promise<PickedNote[]> {
    const r = await this.reader.request<{ handoffs: { id: string; spaceId: string | null; sealed: string; createdAt: string }[] }>("GET", "handoffs");
    if (r.handoffs.length === 0) return [];
    const spaces = r.handoffs.some((h) => h.spaceId) ? await this.spaces() : [];
    const own = await agentHandoffKey(this.reader.appSecret);
    const out: PickedNote[] = [];
    for (const h of r.handoffs) {
      const space = h.spaceId ? spaces.find((s) => s.space.id === h.spaceId)?.space : null;
      try {
        const key = h.spaceId ? (space ? await spaceHandoffKey(space.raw) : null) : own;
        if (!key) continue;
        out.push({ ...(await openHandoff(key, h.id, h.sealed)), id: h.id, space: space?.name ?? null });
      } catch {
        // A note sealed under an older space key stays where it is.
      }
    }
    if (out.length) await this.reader.request("POST", "handoffs/picked", { ids: out.map((n) => n.id) });
    return out;
  }

  /** Pins the agent's own folder as it is now. Keep the pointer (in a checkpoint, say) to restore exactly this later. */
  async pin(): Promise<PinnedVersion> {
    const p = await this.reader.request<MemoryPointer & { pinnedAt: string }>("POST", "pins");
    const host = new URL(p.node).host;
    return { ...p, pointer: `sigil://${host}/${p.folder}@${p.version}#${p.hash}` };
  }

  /**
   * The agent's own folder exactly as it was at a version. The encrypted
   * memories are hashed here and compared with the server's fingerprint, and
   * with the pinned one when it is given, before they are opened.
   */
  async restore(version: number, expectHash?: string): Promise<RestoredVersion> {
    const r = await this.reader.request<{ folder: string; version: number; newest: number; hash: string; memories: { id: string; folderId: string; head: string; body: string; updatedAt: string }[] }>(
      "GET",
      `version/${version}`,
    );
    const computed = versionHash(r.memories);
    const verified = computed === r.hash && (!expectHash || expectHash === computed);
    if (expectHash && expectHash !== computed) {
      throw new ClientError(`Version ${version} does not match the pinned fingerprint. Expected ${expectHash}, got ${computed}.`, 409, "version_mismatch");
    }
    const home = (await this.folders()).find((f) => f.folder.id === r.folder)?.folder;
    if (!home) throw new ClientError("This agent's own folder is not available.", 403, "read_only");
    const memories: RecallHit[] = [];
    for (const m of r.memories) {
      const open = await decryptMemory(home, m);
      memories.push({ id: open.id, title: open.title, where: home.name, body: open.body, editedAt: open.editedAt, tags: open.tags });
    }
    return { version: r.version, newest: r.newest, hash: computed, verified, memories };
  }
}
