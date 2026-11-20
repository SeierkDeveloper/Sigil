import { describe, expect, it } from "vitest";
import {
  agreementHash,
  boxKeyPairFromSecret,
  cleanAgreementDoc,
  encodeBoxPublicKey,
  entryLeaf,
  fromHex32,
  hex32,
  merkleProof,
  merkleRoot,
  parseAgreement,
  partyIndex,
  randomBytes,
  signAgreement,
  toHex,
  vaultSigningKey,
  verifyAgreement,
  verifyAgreementSignature,
  type AgreementDoc,
  type SignedAgreement,
} from "../src";

const A = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const B = Uint8Array.from({ length: 32 }, (_, i) => 90 + i);

async function parties() {
  const ka = await vaultSigningKey(A);
  const kb = await vaultSigningKey(B);
  const pa = { name: "Sam", boxKey: encodeBoxPublicKey(boxKeyPairFromSecret(A).publicKey), signingKey: ka.publicKey };
  const pb = { name: "Robin", boxKey: encodeBoxPublicKey(boxKeyPairFromSecret(B).publicKey), signingKey: kb.publicKey };
  return { ka, kb, pa, pb };
}

async function signed(text = "Sam lends Robin the camera until 1 December. Robin returns it unharmed."): Promise<SignedAgreement> {
  const { ka, kb, pa, pb } = await parties();
  const doc = cleanAgreementDoc({ title: "The camera", text, parties: [pa, pb] });
  const hash = agreementHash(doc);
  const at = "2026-11-20T10:00:05.000Z";
  const base = { id: "entry-000001", appId: "agreement-01", kind: "agreement" as const, memoryId: hash, count: 2, at, salt: toHex(randomBytes(32)), hour: Math.floor(Date.parse(at) / 3600_000), index: 0, proof: [] as string[], root: "" };
  const leaves = [hex32(randomBytes(32)), entryLeaf(base), hex32(randomBytes(32))].map(fromHex32);
  return {
    format: "sigil-agreement",
    version: 1,
    doc,
    hash,
    signatures: [signAgreement(ka, hash), signAgreement(kb, hash)],
    seal: { ...base, party: 1, index: 1, proof: merkleProof(leaves, 1).map(hex32), root: hex32(merkleRoot(leaves)) },
  };
}

describe("an agreement", () => {
  it("names two different vaults, and an amendment names the version it replaces", async () => {
    const { pa, pb } = await parties();
    expect(() => cleanAgreementDoc({ title: "x", text: "y", parties: [pa, pa] })).toThrow(/same vault/);
    expect(() => cleanAgreementDoc({ title: "", text: "y", parties: [pa, pb] })).toThrow(/title/);
    expect(() => cleanAgreementDoc({ title: "x", text: "y", parties: [pa, pb], version: 2 })).toThrow(/earlier version/);
    const v1 = cleanAgreementDoc({ title: "x", text: "y", parties: [pa, pb] });
    const v2 = cleanAgreementDoc({ ...v1, text: "y, amended", version: 2, previous: agreementHash(v1) });
    expect(v2.previous).toBe(agreementHash(v1));
    expect(partyIndex(v2, pb.signingKey)).toBe(1);
    expect(partyIndex(v2, "nobody")).toBe(-1);
  });

  it("hashes the same document the same way, and a nonce keeps short texts from being guessed", async () => {
    const { pa, pb } = await parties();
    const one = cleanAgreementDoc({ title: "Yes", text: "Yes", parties: [pa, pb], createdAt: "2026-11-20T00:00:00.000Z" });
    const two = cleanAgreementDoc({ title: "Yes", text: "Yes", parties: [pa, pb], createdAt: "2026-11-20T00:00:00.000Z" });
    expect(agreementHash(one)).toBe(agreementHash(JSON.parse(JSON.stringify(one)) as AgreementDoc));
    expect(agreementHash(one)).not.toBe(agreementHash(two));
  });

  it("is signed by both parties over the same hash and checks in full", async () => {
    const a = await signed();
    const roots = async () => new Map([[a.seal!.hour, a.seal!.root]]);
    const r = await verifyAgreement(parseAgreement(JSON.stringify(a)), { published: roots, periodSeconds: 3600 });
    expect(r.checks.map((c) => [c.name, c.ok])).toEqual([
      ["hash", true],
      ["party-1", true],
      ["party-2", true],
      ["seal", true],
      ["published", true],
    ]);
    expect(r.ok).toBe(true);
  });

  it("fails when a word of the text is changed after signing", async () => {
    const a = await signed();
    const r = await verifyAgreement({ ...a, doc: { ...a.doc, text: a.doc.text.replace("1 December", "1 January") } });
    expect(r.checks[0]).toMatchObject({ name: "hash", ok: false });
    expect(r.ok).toBe(false);
  });

  it("fails when one signature is someone else's, or missing", async () => {
    const a = await signed();
    const stranger = await vaultSigningKey(Uint8Array.from({ length: 32 }, () => 7));
    expect((await verifyAgreement({ ...a, signatures: [a.signatures[0], signAgreement(stranger, a.hash)] })).checks[2].ok).toBe(false);
    expect((await verifyAgreement({ ...a, signatures: [a.signatures[0], ""] })).ok).toBe(false);
    expect(verifyAgreementSignature(a.doc.parties[0].signingKey, a.hash, a.signatures[1])).toBe(false);
  });

  it("needs the sealed entry of this hash, with a root that matches", async () => {
    const a = await signed();
    expect((await verifyAgreement({ ...a, seal: null })).checks.find((c) => c.name === "seal")?.ok).toBe(false);
    const other = await signed("Another text.");
    expect((await verifyAgreement({ ...a, seal: other.seal })).checks.find((c) => c.name === "seal")?.ok).toBe(false);
    const wrong = async () => new Map([[a.seal!.hour, hex32(randomBytes(32))]]);
    expect((await verifyAgreement(a, { published: wrong })).checks.find((c) => c.name === "published")?.ok).toBe(false);
    expect(() => parseAgreement("[]")).toThrow(/not a Sigil agreement/);
  });
});
