import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  concatBytes,
  hex32,
  leafHash,
  merkleProof,
  merkleRoot,
  nodeHash,
  readEntryLeaf,
  readEntryLeafData,
  utf8,
  verifyProof,
  randomBytes,
} from "../src";

const leaves = (n: number) => Array.from({ length: n }, (_, i) => leafHash(`leaf-${i}`));

describe("merkle", () => {
  it("prefixes leaves and nodes differently", () => {
    expect(leafHash("x")).toEqual(sha256(concatBytes(new Uint8Array([0]), utf8("x"))));
    const a = leafHash("a");
    const b = leafHash("b");
    expect(nodeHash(a, b)).toEqual(nodeHash(b, a));
    expect(nodeHash(a, b)).not.toEqual(leafHash(concatBytes(a, b)));
  });

  it("root of one leaf is the leaf; empty root is zero", () => {
    const [l] = leaves(1);
    expect(merkleRoot([l])).toEqual(l);
    expect(merkleRoot([])).toEqual(new Uint8Array(32));
  });

  it("every proof verifies for sizes 1 to 40", () => {
    for (let n = 1; n <= 40; n++) {
      const ls = leaves(n);
      const root = merkleRoot(ls);
      for (let i = 0; i < n; i++) {
        expect(verifyProof(root, ls[i], merkleProof(ls, i))).toBe(true);
      }
    }
  });

  it("rejects a wrong leaf, a wrong root and a tampered proof", () => {
    const ls = leaves(9);
    const root = merkleRoot(ls);
    const proof = merkleProof(ls, 4);
    expect(verifyProof(root, leafHash("other"), proof)).toBe(false);
    expect(verifyProof(randomBytes(32), ls[4], proof)).toBe(false);
    const bad = proof.map((p) => p.slice());
    bad[0][0] ^= 1;
    expect(verifyProof(root, ls[4], bad)).toBe(false);
    expect(() => merkleProof(ls, 9)).toThrow();
  });

  it("read-log leaves depend on every field including the salt", () => {
    const e = { id: "e1", appId: "a1", kind: "read" as const, memoryId: "m1", count: 1, at: "2026-01-01T00:00:00.000Z", salt: "ab".repeat(32) };
    expect(readEntryLeafData(e).split("\n")[0]).toBe("sigil-read-v1");
    const base = hex32(readEntryLeaf(e));
    for (const change of [{ id: "e2" }, { appId: "a2" }, { kind: "index" as const }, { memoryId: null }, { count: 2 }, { at: "2026-01-01T00:00:00.001Z" }, { salt: "cd".repeat(32) }]) {
      expect(hex32(readEntryLeaf({ ...e, ...change }))).not.toBe(base);
    }
  });

  it("matches the vector used by the Solidity tests", () => {
    // Keep in step with contracts/test/SigilSeal.t.sol (testVectorFromTypeScript).
    const ls = [leafHash("sigil-a"), leafHash("sigil-b"), leafHash("sigil-c")];
    const root = merkleRoot(ls);
    expect(hex32(ls[0])).toBe(VECTOR.leafA);
    expect(hex32(root)).toBe(VECTOR.root);
    expect(merkleProof(ls, 0).map(hex32)).toEqual(VECTOR.proofA);
  });
});

// Filled in from the implementation once and then frozen, so a change in either
// the TypeScript or the Solidity hashing breaks a test.
const VECTOR = {
  leafA: "0x2ec63fa6a5e8a56c9b2eac25efd9293f0d3deee2f757cbc5ebfac68683d0d9c6",
  root: "0xc23750ad4b065541539f1c35afeddbd1816a73097b8720197308c0dfea7ba41e",
  proofA: [
    "0xb0d262a6efefad4a872e74542e824dc9c0726161e0d6996e77f5c4dc0265793e",
    "0x2ddf0622ad38d84755f555cfc0d0f8c9cea56d4c4c947243b7680948cb3ae3ab",
  ],
};
