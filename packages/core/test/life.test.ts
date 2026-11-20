import { describe, expect, it } from "vitest";
import {
  buildCertificate,
  canonicalJson,
  hex32,
  fromHex32,
  merkleProof,
  merkleRoot,
  parseCertificate,
  presenceLeaf,
  presenceMessage,
  randomId,
  signPresence,
  summarizeHours,
  toHex,
  randomBytes,
  vaultSigningKey,
  verifyCertificate,
  verifyPresence,
  type CertificateHour,
  type SigningKey,
} from "../src/index";

const ORIGIN = "https://example.org";
const PERIOD = 3600;

/** One sealed hour with our presence leaf among a few other leaves, as the server would seal it. */
function sealedHour(key: SigningKey, hour: number, others = 3): CertificateHour {
  const entry = { id: randomId(), at: new Date(hour * PERIOD * 1000 + 1234).toISOString(), salt: toHex(randomBytes(32)), sig: signPresence(key, ORIGIN, hour, PERIOD) };
  const leaves = [...Array.from({ length: others }, () => hex32(randomBytes(32))), presenceLeaf(entry)];
  const index = leaves.length - 1;
  return { hour, entry, index, proof: merkleProof(leaves.map(fromHex32), index).map(hex32), root: hex32(merkleRoot(leaves.map(fromHex32))) };
}

describe("presence", () => {
  it("signs the hour with a key derived from the vault key", async () => {
    const key = await vaultSigningKey(new Uint8Array(32).fill(5));
    expect((await vaultSigningKey(new Uint8Array(32).fill(5))).publicKey).toBe(key.publicKey);
    expect((await vaultSigningKey(new Uint8Array(32).fill(6))).publicKey).not.toBe(key.publicKey);
    const sig = signPresence(key, ORIGIN, 500_000, PERIOD);
    expect(verifyPresence(key.publicKey, ORIGIN, 500_000, PERIOD, sig)).toBe(true);
    expect(verifyPresence(key.publicKey, ORIGIN, 500_001, PERIOD, sig)).toBe(false);
    expect(verifyPresence(key.publicKey, "https://other.example", 500_000, PERIOD, sig)).toBe(false);
    expect(verifyPresence(key.publicKey, ORIGIN, 500_000, 4, sig)).toBe(false);
    expect(verifyPresence(key.publicKey, ORIGIN, 500_000, PERIOD, "x")).toBe(false);
    expect(presenceMessage(`${ORIGIN}/`, 1, 2)).toBe(presenceMessage(ORIGIN, 1, 2));
  });
});

describe("the summary", () => {
  it("counts hours, days, the longest gap and the run with no gap over 30 days", () => {
    const day = 24;
    const base = 480_000; // a whole day in hours
    const hours = [base, base + 1, base + 1, base + 5, base + 3 * day, base + 40 * day, base + 41 * day, base + 100 * day];
    const s = summarizeHours(hours, PERIOD);
    expect(s.firstHour).toBe(base);
    expect(s.lastHour).toBe(base + 100 * day);
    expect(s.activeHours).toBe(7);
    expect(s.activeDays).toBe(5);
    // Between day 41 and day 100 there are 59 days minus one hour without presence.
    expect(s.longestGapHours).toBe(59 * day - 1);
    expect(s.spanDays).toBe(100);
    // The run started again at day 100, after the 59-day gap.
    expect(s.continuousDays).toBe(0);
    expect(s.continuousMonths).toBe(0);
    const steady = summarizeHours(
      Array.from({ length: 13 }, (_, i) => base + i * 20 * day),
      PERIOD,
    );
    expect(steady.continuousDays).toBe(240);
    expect(steady.continuousMonths).toBe(8);
    expect(() => summarizeHours([], PERIOD)).toThrow("no sealed presence");
  });

  it("orders keys canonically", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }], e: undefined })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });
});

describe("certificates", () => {
  async function certificate() {
    const key = await vaultSigningKey(new Uint8Array(32).fill(1));
    const hours = [490_000, 490_001, 490_030, 490_200].map((h) => sealedHour(key, h));
    return { key, hours, cert: buildCertificate(key, { origin: ORIGIN, periodSeconds: PERIOD, hours }) };
  }
  const roots = (hours: CertificateHour[]) => async () => new Map(hours.map((h) => [h.hour, h.root]));

  it("verifies end to end against the published roots and the chain", async () => {
    const { cert, hours } = await certificate();
    expect(JSON.stringify(cert)).not.toContain("salted-content");
    const r = await verifyCertificate(parseCertificate(JSON.stringify(cert)), { published: roots(hours), onChain: roots(hours) });
    expect(r.checks.map((c) => [c.name, c.ok])).toEqual([
      ["signature", true],
      ["presence", true],
      ["proofs", true],
      ["summary", true],
      ["published", true],
      ["chain", true],
    ]);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatchObject({ activeHours: 4, activeDays: 3 });
  });

  it("fails when anything was changed", async () => {
    const { cert, hours, key } = await certificate();
    const edit = (fn: (c: typeof cert) => void) => {
      const c = JSON.parse(JSON.stringify(cert));
      fn(c);
      return c;
    };
    const failed = async (c: typeof cert, opts = {}) => (await verifyCertificate(c, opts)).checks.filter((x) => !x.ok).map((x) => x.name);

    // A summary that claims more than the hours show.
    expect(await failed(edit((c) => (c.body.summary.activeHours = 400)))).toContain("signature");
    // A presence statement moved to another hour.
    expect(await failed(edit((c) => (c.body.hours[1].entry.sig = c.body.hours[0].entry.sig)))).toEqual(expect.arrayContaining(["signature", "presence"]));
    // A proof that leads elsewhere.
    expect(await failed(edit((c) => (c.body.hours[2].root = hex32(randomBytes(32)))))).toEqual(expect.arrayContaining(["signature", "proofs"]));
    // Signed by another vault.
    const other = await vaultSigningKey(new Uint8Array(32).fill(2));
    const forged = buildCertificate(other, { origin: ORIGIN, periodSeconds: PERIOD, hours });
    expect(await failed(forged)).toContain("presence");
    // A root the site never published, re-signed by the same key.
    const fake = hours.map((h, i) => (i === 0 ? sealedHour(key, h.hour) : h));
    const resigned = buildCertificate(key, { origin: ORIGIN, periodSeconds: PERIOD, hours: fake });
    expect(await failed(resigned, { published: roots(hours) })).toEqual(["published"]);
    // A source that is missing hours, or cannot be reached.
    expect(await failed(cert, { onChain: async () => new Map() })).toEqual(["chain"]);
    expect(await failed(cert, { published: async () => Promise.reject(new Error("offline")) })).toEqual(["published"]);
  });

  it("refuses files that are not certificates", () => {
    expect(() => parseCertificate("nope")).toThrow("not valid JSON");
    expect(() => parseCertificate("{}")).toThrow("not a Sigil life certificate");
  });
});
