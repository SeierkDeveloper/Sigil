import { describe, expect, it } from "vitest";
import { hashMessage, recoverMessageAddress } from "viem";
import { selfIdentityKey } from "../src/identity";
import { fromHex32, hex32, merkleProof, merkleRoot, leafHash } from "../src/merkle";
import { checkReceipt, parseReceipt, receiptLeaf, receiptMessage, signReceipt } from "../src/receipts";
import { toHex } from "../src/encoding";

const VAULT = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

describe("receipts", () => {
  it("are signed by the self key the way wallets sign text, and check in full", async () => {
    const self = await selfIdentityKey(VAULT);
    const r = signReceipt(self, { kind: "payment", what: "Paid 0.01 to A friend", limit: "Payments to listed recipients, within the wallet's caps on chain", ref: { chainId: "4663", tx: "0xabc" }, origin: "https://vault.example" });
    expect(r.body.selfKey).toBe(self.address);
    expect(r.body.salt).toMatch(/^[0-9a-f]{64}$/);
    // Any wallet library reads the signature as an EIP-191 personal signature by the self key.
    expect(await recoverMessageAddress({ message: receiptMessage(r.body), signature: r.signature as `0x${string}` })).toBe(self.address);
    expect(hashMessage(receiptMessage(r.body))).toMatch(/^0x/);
    expect(checkReceipt({ receipt: r, seal: null })).toMatchObject({ ok: true, leaf: receiptLeaf(r) });
  });

  it("fail when the receipt is changed, or signed by another key", async () => {
    const self = await selfIdentityKey(VAULT);
    const other = await selfIdentityKey(Uint8Array.from({ length: 32 }, (_, i) => 100 - i));
    const r = signReceipt(self, { kind: "approval", what: "Approved a reply to Sam", limit: "Replies to listed contacts (sam@example.org)", ref: {}, origin: "https://vault.example" });
    expect(checkReceipt({ receipt: { ...r, body: { ...r.body, what: "Approved a reply to Mallory" } }, seal: null }).ok).toBe(false);
    const forged = signReceipt(other, { ...r.body });
    expect(checkReceipt({ receipt: { ...forged, body: { ...forged.body, selfKey: self.address } }, seal: null }).ok).toBe(false);
  });

  it("are proved in a seal by their leaf, and the leaf says nothing without the receipt", async () => {
    const self = await selfIdentityKey(VAULT);
    const at = "2030-01-07T09:15:00.000Z";
    const r = signReceipt(self, { kind: "agreement", what: "Agreed a meeting with Robin on 2030-01-08 10:00", limit: "Meetings in free hours", ref: { meetId: "m1" }, origin: "https://vault.example", at });
    const twin = signReceipt(self, { ...r.body, salt: undefined });
    expect(receiptLeaf(twin)).not.toBe(receiptLeaf(r));
    const others = [leafHash("a"), leafHash("b"), leafHash("c")];
    const leaves = [others[0], fromHex32(receiptLeaf(r)), others[1], others[2]];
    const root = hex32(merkleRoot(leaves));
    const proof = merkleProof(leaves, 1).map(hex32);
    const hour = Math.floor(Date.parse(at) / 3_600_000);
    const shared = parseReceipt(JSON.stringify({ receipt: r, seal: { hour, proof, root } }));
    expect(checkReceipt(shared)).toMatchObject({ ok: true });
    expect(checkReceipt({ ...shared, seal: { ...shared.seal!, root: hex32(leafHash("x")) } }).checks.find((c) => c.name === "seal")?.ok).toBe(false);
    expect(checkReceipt({ ...shared, seal: { ...shared.seal!, hour: hour + 5 } }).checks.find((c) => c.name === "time")?.ok).toBe(false);
    expect(() => parseReceipt("{}")).toThrow(/not a Sigil receipt/);
    expect(toHex(fromHex32(receiptLeaf(r)))).toHaveLength(64);
  });
});
