// Merkle trees for the hourly seal of the read log.
//
//   leaf = sha256(0x00 || data)
//   node = sha256(0x01 || min(a, b) || max(a, b))
//
// Pairs are sorted before hashing, so a proof is just the list of siblings and
// needs no left/right flags. An odd node at the end of a level moves up as is.
// The same rules are implemented in contracts/src/SigilSeal.sol.

import { sha256 } from "@noble/hashes/sha2.js";
import { compareBytes, concatBytes, fromHex, toHex, utf8 } from "./encoding";

const LEAF_PREFIX = new Uint8Array([0x00]);
const NODE_PREFIX = new Uint8Array([0x01]);
export const ZERO_ROOT = "0x" + "00".repeat(32);

export function leafHash(data: Uint8Array | string): Uint8Array {
  return sha256(concatBytes(LEAF_PREFIX, typeof data === "string" ? utf8(data) : data));
}

export function nodeHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(concatBytes(NODE_PREFIX, lo, hi));
}

function levels(leaves: Uint8Array[]): Uint8Array[][] {
  const out: Uint8Array[][] = [leaves];
  let level = leaves;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i]);
    }
    out.push(next);
    level = next;
  }
  return out;
}

export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(32);
  const all = levels(leaves);
  return all[all.length - 1][0];
}

export function merkleProof(leaves: Uint8Array[], index: number): Uint8Array[] {
  if (index < 0 || index >= leaves.length) throw new Error("Leaf index out of range.");
  const proof: Uint8Array[] = [];
  let i = index;
  for (const level of levels(leaves).slice(0, -1)) {
    const sibling = i % 2 === 0 ? i + 1 : i - 1;
    if (sibling < level.length) proof.push(level[sibling]);
    i = Math.floor(i / 2);
  }
  return proof;
}

/**
 * The tree built once, for many proofs: an hour with thousands of entries needs
 * thousands of proofs, and building the tree again for each would be quadratic.
 */
export function merkleTree(leaves: Uint8Array[]): { root: Uint8Array; proof(index: number): Uint8Array[] } {
  const all = leaves.length ? levels(leaves) : [[new Uint8Array(32)]];
  return {
    root: all[all.length - 1][0],
    proof(index: number) {
      if (index < 0 || index >= leaves.length) throw new Error("Leaf index out of range.");
      const proof: Uint8Array[] = [];
      let i = index;
      for (const level of all.slice(0, -1)) {
        const sibling = i % 2 === 0 ? i + 1 : i - 1;
        if (sibling < level.length) proof.push(level[sibling]);
        i = Math.floor(i / 2);
      }
      return proof;
    },
  };
}

export function verifyProof(root: Uint8Array, leaf: Uint8Array, proof: Uint8Array[]): boolean {
  let node = leaf;
  for (const sibling of proof) node = nodeHash(node, sibling);
  return compareBytes(node, root) === 0;
}

export const hex32 = (bytes: Uint8Array) => "0x" + toHex(bytes);
export const fromHex32 = (hex: string) => {
  const bytes = fromHex(hex);
  if (bytes.length !== 32) throw new Error("Expected 32 bytes.");
  return bytes;
};

// ---------------------------------------------------------------- read log leaves

/**
 * What an entry records: an app listing folders, reading the index or a memory,
 * suggesting a memory, another vault opening a shared folder, or the AI self
 * answering a question (through an ask link or an app). For "ask" entries the
 * memory id field holds the question's id, which the sealed note is bound to.
 *
 * Later kinds:
 *   legacy     a step of the legacy plan (made, changed, check-in, warning, request, share passed, released, opened, a question)
 *   device     a device added, signed in for the first time, or revoked
 *   presence   the owner's vault was open in that hour; the memory id field holds the vault's signature over the hour
 *   remember   an agent wrote a memory          forget    an agent deleted one
 *   handoff    an agent left or picked up a note space     a team space was read, written or changed
 *   protected  a memory in a protected folder was read, after the owner's yes (the memory id field holds the memory)
 *   approval   the owner said yes or no to a request to read a protected folder
 *   public     the public AI self answered a question (sealed note, like "ask")
 *   meet       a step of a conversation between two AI selves (invite, answer, a turn, stop)
 *   sync       a connector wrote what a live sync source fetched, in the background
 *   identity   a step of the AI self's identity (its key made, a statement signed, rules saved)
 *   work       a step of the AI self's work: a draft made, approved, sent, discarded, or a lesson learned
 *   disclose   a proof of a fact was made; the memory id field holds the signed statement's hash
 *   emergency  the emergency card was published, revoked, or opened (a count of opens)
 *   agreement  an agreement was proposed, signed, declined or withdrawn; the memory id field holds its hash
 *   pack       a knowledge pack was published or followed, or a new version taken in
 *
 * Added in version 1.2:
 *   backup     a bundle of the vault was made and stored; the memory id field holds its hash
 *   node       a step of moving the vault between nodes, or restoring it on one
 *   capture    a device's capture key sent something to the inbox, or the key was made or revoked
 *   session    a step of a session with the public AI self: booked, a turn answered, ended or blocked
 *   injection  the immune system caught hidden instructions: memories held back or places neutralised before a model saw them
 */
export type ReadKind =
  | "folders"
  | "index"
  | "read"
  | "propose"
  | "shared"
  | "ask"
  | "legacy"
  | "device"
  | "presence"
  | "remember"
  | "forget"
  | "handoff"
  | "space"
  | "protected"
  | "approval"
  | "public"
  | "meet"
  | "sync"
  | "identity"
  | "work"
  | "disclose"
  | "emergency"
  | "agreement"
  | "pack"
  | "backup"
  | "node"
  | "capture"
  | "session"
  | "injection";

export const READ_KINDS: readonly ReadKind[] = [
  "folders",
  "index",
  "read",
  "propose",
  "shared",
  "ask",
  "legacy",
  "device",
  "presence",
  "remember",
  "forget",
  "handoff",
  "space",
  "protected",
  "approval",
  "public",
  "meet",
  "sync",
  "identity",
  "work",
  "disclose",
  "emergency",
  "agreement",
  "pack",
  "backup",
  "node",
  "capture",
  "session",
  "injection",
];

export interface ReadEntryFields {
  id: string;
  appId: string;
  kind: ReadKind;
  memoryId: string | null;
  count: number;
  at: string;
  /** 32 random bytes as hex. Without it the leaf cannot be linked to the entry. */
  salt: string;
}

/** The exact bytes that go into a read-log leaf. Anyone holding the entry and its salt can recompute it. */
export function readEntryLeafData(e: ReadEntryFields): string {
  return ["sigil-read-v1", e.id, e.appId, e.kind, e.memoryId ?? "", String(e.count), e.at, e.salt].join("\n");
}

export function readEntryLeaf(e: ReadEntryFields): Uint8Array {
  return leafHash(readEntryLeafData(e));
}
