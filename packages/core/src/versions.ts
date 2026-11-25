// Pinned versions of an agent's own folder. Every change to the folder (a
// memory remembered, changed or forgotten) gives the folder a new version
// number, and the folder exactly as it was at any version can be fetched
// again, even after the agent writes more. A version's fingerprint is a hash of
// the encrypted memories in it, so whoever kept a pointer (an agent framework's
// checkpoint, say) can check that a restore returns exactly what was pinned.
// The server computes it over ciphertext; the agent's machine computes the same
// over what it received, so neither has to trust the other.

import { sha256Hex } from "./keys";

/** One memory in a version, as stored: encrypted head and body. */
export interface VersionedMemory {
  id: string;
  head: string;
  body?: string | null;
}

/** The fingerprint of a folder version: sha256 over each memory's id and the hash of its ciphertext, in id order. */
export function versionHash(memories: VersionedMemory[]): string {
  const lines = [...memories]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((m) => `${m.id}:${sha256Hex(`${m.head}\n${m.body ?? ""}`)}`);
  return `sha256:${sha256Hex(lines.join("\n"))}`;
}

/** What an agent keeps to restore its memory later: the node, the vault, its folder, the version and its fingerprint. */
export interface MemoryPointer {
  node: string;
  vault: string | null;
  folder: string;
  version: number;
  hash: string;
}

/** The pointer as one string, for a field in someone else's checkpoint: sigil://<node host>/<folder>@<version>#<hash>. */
export function pointerString(p: Pick<MemoryPointer, "node" | "folder" | "version" | "hash">): string {
  return `sigil://${new URL(p.node).host}/${p.folder}@${p.version}#${p.hash}`;
}

/** Reads a pointer string back. Throws on anything else. */
export function parsePointer(s: string): { host: string; folder: string; version: number; hash: string } {
  const m = /^sigil:\/\/([^/\s]+)\/([A-Za-z0-9_-]{8,64})@(\d{1,12})#(sha256:[0-9a-f]{64})$/.exec(s.trim());
  if (!m) throw new Error("That is not a Sigil memory pointer. It looks like sigil://node/folder@version#sha256:...");
  return { host: m[1], folder: m[2], version: Number(m[3]), hash: m[4] };
}
