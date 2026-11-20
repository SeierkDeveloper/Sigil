// Moving a vault between nodes: the move statement the owner's device signs,
// the code carried to the new node, and the arrival the old node checks.

import { describe, expect, it } from "vitest";
import {
  cleanMove,
  formatMoveCode,
  moveHash,
  moveUrl,
  newMoveId,
  newMoveSecret,
  newVaultKey,
  nodeOrigin,
  parseMoveCode,
  signArrival,
  signMove,
  vaultSigningKey,
  verifyArrival,
  verifyMove,
} from "../src/index";

const BUNDLE = `0x${"ab".repeat(32)}`;

describe("a node's address", () => {
  it("is an https origin, or http on this machine", () => {
    expect(nodeOrigin("https://sigil.example.org/vault?x=1")).toBe("https://sigil.example.org");
    expect(nodeOrigin("http://localhost:3211/")).toBe("http://localhost:3211");
    expect(() => nodeOrigin("http://sigil.example.org")).toThrow(/https/);
    expect(() => nodeOrigin("not a url")).toThrow(/not a node address/);
  });
});

describe("a move statement", () => {
  it("is signed by the vault's key and checked against it", async () => {
    const key = await vaultSigningKey(newVaultKey());
    const m = signMove(key, { id: newMoveId(), from: "https://old.example", to: "https://new.example", bundle: BUNDLE, redirectDays: 30, issuedAt: "2026-11-20T12:00:00.000Z" });
    expect(m.statement.vault).toBe(key.publicKey);
    expect(verifyMove(m)).toBe(true);
    expect(verifyMove(m, key.publicKey)).toBe(true);
    expect(verifyMove(m, (await vaultSigningKey(newVaultKey())).publicKey)).toBe(false);
    expect(verifyMove({ ...m, statement: { ...m.statement, to: "https://thief.example" } })).toBe(false);
    expect(verifyMove({ ...m, statement: { ...m.statement, redirectDays: 90 } })).toBe(false);
    expect(moveHash(m.statement)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("names two different nodes, a bundle and a period of 1 to 90 days", async () => {
    const key = await vaultSigningKey(newVaultKey());
    const base = { id: newMoveId(), from: "https://old.example", to: "https://new.example", bundle: BUNDLE, redirectDays: 30, issuedAt: "2026-11-20T12:00:00.000Z" };
    expect(() => signMove(key, { ...base, to: base.from })).toThrow(/another node/);
    expect(() => signMove(key, { ...base, redirectDays: 0 })).toThrow(/1 to 90 days/);
    expect(() => signMove(key, { ...base, bundle: "0x12" })).toThrow(/bundle/);
    expect(() => cleanMove({ format: "other" })).toThrow(/not a Sigil move/);
  });
});

describe("the move code and the arrival", () => {
  it("carries the old node, the move and its secret, and opens on the new node's restore page", () => {
    const code = formatMoveCode({ from: "http://localhost:3210", id: "move-0000001", secret: newMoveSecret() });
    expect(code.startsWith("sigil_move.")).toBe(true);
    const back = parseMoveCode(code);
    expect(back.from).toBe("http://localhost:3210");
    expect(back.id).toBe("move-0000001");
    expect(() => parseMoveCode(code.slice(0, -4))).toThrow(/not complete/);
    expect(() => parseMoveCode("sigil_move.aGVsbG8.move-0000001.x")).toThrow(/not complete/);
    expect(moveUrl("https://new.example/", code)).toBe(`https://new.example/vault/restore#move=${code}`);
  });

  it("is signed on the new node by the same vault key and names where the vault went", async () => {
    const key = await vaultSigningKey(newVaultKey());
    const sig = signArrival(key, "move-0000001", "https://new.example", BUNDLE, "2026-11-20T12:05:00.000Z");
    expect(verifyArrival(key.publicKey, "move-0000001", "https://new.example", BUNDLE, "2026-11-20T12:05:00.000Z", sig)).toBe(true);
    expect(verifyArrival(key.publicKey, "move-0000001", "https://other.example", BUNDLE, "2026-11-20T12:05:00.000Z", sig)).toBe(false);
    expect(verifyArrival(key.publicKey, "move-0000002", "https://new.example", BUNDLE, "2026-11-20T12:05:00.000Z", sig)).toBe(false);
  });
});
