// The vault deploys the self's wallet from the owner's own browser wallet with
// the creation code in src/vault/selfWalletCode.ts. It must be the code Foundry
// builds from contracts/src/SigilSelfWallet.sol. The end-to-end test also
// deploys it on a local chain and runs the whole flow against it.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SELF_WALLET_BYTECODE } from "../src/vault/selfWalletCode";

const BUILD = path.resolve(import.meta.dirname, "../../contracts/out/SigilSelfWallet.sol/SigilSelfWallet.json");

describe("the self wallet's creation code", () => {
  it.skipIf(!existsSync(BUILD))("is the code Foundry builds from the contract (run forge build first)", () => {
    const art = JSON.parse(readFileSync(BUILD, "utf8")) as { bytecode: { object: string } };
    expect(SELF_WALLET_BYTECODE).toBe(art.bytecode.object);
  });

  it("is creation code, small enough for a chain", () => {
    expect(SELF_WALLET_BYTECODE).toMatch(/^0x60806040/);
    expect((SELF_WALLET_BYTECODE.length - 2) / 2).toBeLessThan(49_152);
  });
});
