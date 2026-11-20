import { describe, expect, it } from "vitest";
import {
  beforeClaim,
  commitFields,
  entryLeaf,
  fieldClaim,
  fieldDate,
  fromHex32,
  hex32,
  historyClaim,
  memoryFields,
  merkleProof,
  merkleRoot,
  parseDisclosure,
  presenceLeaf,
  randomBytes,
  signDisclosure,
  signPresence,
  statementHash,
  toHex,
  vaultSigningKey,
  verifyDisclosure,
  yearsBefore,
  type CertificateHour,
  type Disclosure,
  type DisclosureStatement,
  type RootSource,
  type SealedEntry,
} from "../src";

const VAULT = Uint8Array.from({ length: 32 }, (_, i) => i + 9);
const ORIGIN = "https://sigil.example";
const PERIOD = 3600;
const salt = () => toHex(randomBytes(32));
const noise = (n: number) => Array.from({ length: n }, () => hex32(randomBytes(32)));

/** Puts a leaf among others and returns its index, proof and root, the way the server seals an hour. */
function seal(leaf: string, others = 4) {
  const leaves = [...noise(others), leaf].map(fromHex32);
  const index = leaves.length - 1;
  return { index, proof: merkleProof(leaves, index).map(hex32), root: hex32(merkleRoot(leaves)) };
}

async function presenceHour(hour: number): Promise<CertificateHour> {
  const key = await vaultSigningKey(VAULT);
  const entry = { id: `presence-${hour}`, at: new Date(hour * PERIOD * 1000 + 60_000).toISOString(), salt: salt(), sig: signPresence(key, ORIGIN, hour, PERIOD) };
  return { hour, entry, ...seal(presenceLeaf(entry)) };
}

function anchorFor(statement: DisclosureStatement, at = new Date(Date.parse(statement.issuedAt) + 5000)): SealedEntry {
  const hour = Math.floor(at.getTime() / 1000 / PERIOD);
  const base = { id: "anchor-0001", appId: "vault", kind: "disclose" as const, memoryId: statementHash(statement), count: 1, at: at.toISOString(), salt: salt(), hour, index: 0, proof: [] as string[], root: "" };
  return { ...base, ...seal(entryLeaf(base)) };
}

const rootsOf = (d: Disclosure): RootSource => async () => {
  const m = new Map<number, string>();
  const c = d.statement.claim;
  if (d.anchor) m.set(d.anchor.hour, d.anchor.root);
  if (c.kind === "history") {
    m.set(c.first.hour, c.first.root);
    m.set(c.latest.hour, c.latest.root);
  }
  if (c.kind === "member") m.set(c.entry.hour, c.entry.root);
  return m;
};

async function made(claim: DisclosureStatement["claim"], issuedAt = "2026-11-20T10:00:00.000Z"): Promise<Disclosure> {
  const key = await vaultSigningKey(VAULT);
  const statement: DisclosureStatement = { origin: ORIGIN, periodSeconds: PERIOD, signingKey: key.publicKey, issuedAt, claim };
  const d = signDisclosure(key, statement);
  return { ...d, anchor: anchorFor(statement) };
}

const passport = { title: "Passport", body: "Name: Sam Example\nBorn: 1990-04-02\nNationality: Example\nNumber: X1234567", createdAt: "2026-01-02T00:00:00.000Z" };

describe("fields of a memory", () => {
  it("are the title, every Name: value line and the day it was written", () => {
    expect(memoryFields(passport).map((f) => f.name)).toEqual(["Title", "Name", "Born", "Nationality", "Number", "Written"]);
  });

  it("read dates in the common shapes", () => {
    expect(fieldDate("1990-04-02")).toBe("1990-04-02");
    expect(fieldDate("2 April 1990")).toBe("1990-04-02");
    expect(fieldDate("soon")).toBeNull();
    expect(yearsBefore("2026-11-20", 18)).toBe("2008-11-20");
  });
});

describe("a field claim", () => {
  it("reveals one field, and only that one, and checks in full", async () => {
    const c = commitFields(memoryFields(passport));
    const d = await made(fieldClaim(c, 3));
    const text = JSON.stringify(d);
    expect(text).toContain("Nationality");
    expect(text).not.toContain("1990-04-02");
    expect(text).not.toContain("X1234567");
    const r = await verifyDisclosure(parseDisclosure(text), { published: rootsOf(d) });
    expect(r.ok).toBe(true);
    expect(r.claim).toBe("Nationality: Example");
    expect(r.checks.map((x) => x.name)).toEqual(["signature", "claim", "anchor", "published"]);
  });

  it("fails when the revealed value is changed, even with a fresh signature", async () => {
    const c = commitFields(memoryFields(passport));
    const claim = fieldClaim(c, 3);
    if (claim.kind !== "field") throw new Error();
    claim.opening.value = "Elsewhere";
    const r = await verifyDisclosure(await made(claim));
    expect(r.checks.find((x) => x.name === "claim")?.ok).toBe(false);
  });

  it("fails when the statement is changed after signing", async () => {
    const d = await made(fieldClaim(commitFields(memoryFields(passport)), 1));
    const forged = { ...d, statement: { ...d.statement, issuedAt: "2020-01-01T00:00:00.000Z" } };
    const r = await verifyDisclosure(forged);
    expect(r.ok).toBe(false);
    expect(r.checks[0]).toMatchObject({ name: "signature", ok: false });
  });
});

describe("a date claim", () => {
  it("keeps the date hidden and says plainly who stands behind it", async () => {
    const c = commitFields(memoryFields(passport));
    const d = await made(beforeClaim(c, 2, yearsBefore("2026-11-20", 18), 18));
    expect(JSON.stringify(d)).not.toContain("1990");
    const r = await verifyDisclosure(d, { published: rootsOf(d) });
    expect(r.ok).toBe(true);
    expect(r.claim).toContain("at least 18 years");
    expect(r.attestedBy).toMatch(/owner's own statement/);
  });

  it("refuses to sign a claim the field does not support", () => {
    const c = commitFields(memoryFields(passport));
    expect(() => beforeClaim(c, 2, "1980-01-01")).toThrow(/would not be true/);
    expect(() => beforeClaim(c, 3, "2000-01-01")).toThrow(/not a date/);
  });
});

describe("a history claim", () => {
  it("is checked in full from two sealed presence hours", async () => {
    const first = await presenceHour(490_000);
    const latest = await presenceHour(490_000 + 24 * 95);
    const d = await made(historyClaim(first, latest, PERIOD));
    const r = await verifyDisclosure(d, { published: rootsOf(d) });
    expect(r.ok).toBe(true);
    expect(r.claim).toBe("At least 3 months of sealed history");
  });

  it("fails when it claims more months than the hours show, or a presence is not the vault's", async () => {
    const first = await presenceHour(490_000);
    const latest = await presenceHour(490_000 + 24 * 40);
    const claim = historyClaim(first, latest, PERIOD);
    if (claim.kind !== "history") throw new Error();
    expect((await verifyDisclosure(await made({ ...claim, months: 6 }))).checks.find((x) => x.name === "claim")?.ok).toBe(false);
    const other = { ...latest, entry: { ...latest.entry, sig: first.entry.sig } };
    expect((await verifyDisclosure(await made({ ...claim, latest: other }))).checks.find((x) => x.name === "claim")?.ok).toBe(false);
    expect(() => historyClaim(first, first, PERIOD)).toThrow(/less than a month/);
  });
});

describe("a membership claim", () => {
  it("rests on the sealed entry of the join", async () => {
    const at = "2026-10-01T09:30:00.000Z";
    const base = { id: "join-0000001", appId: "vault", kind: "space" as const, memoryId: "joined-space-00001", count: 1, at, salt: salt(), hour: Math.floor(Date.parse(at) / 1000 / PERIOD), index: 0, proof: [] as string[], root: "" };
    const entry = { ...base, ...seal(entryLeaf(base)) };
    const d = await made({ kind: "member", space: "space-00001", label: "Research", entry });
    const r = await verifyDisclosure(d, { published: rootsOf(d) });
    expect(r.ok).toBe(true);
    expect(r.claim).toBe("Member of the team space Research since 1 October 2026");
    const moved = { ...d, statement: { ...d.statement } };
    expect((await verifyDisclosure({ ...moved, statement: { ...d.statement, claim: { kind: "member", space: "space-00002", label: "Research", entry } } })).ok).toBe(false);
  });
});

describe("the anchor", () => {
  it("is required, must carry this statement's hash, and its root must be the published one", async () => {
    const d = await made(fieldClaim(commitFields(memoryFields(passport)), 0));
    expect((await verifyDisclosure({ ...d, anchor: null })).checks.find((x) => x.name === "anchor")).toMatchObject({ ok: false });
    const other = await made(fieldClaim(commitFields(memoryFields(passport)), 1));
    expect((await verifyDisclosure({ ...d, anchor: other.anchor })).checks.find((x) => x.name === "anchor")?.ok).toBe(false);
    const wrongRoots: RootSource = async (hours) => new Map(hours.map((h) => [h, hex32(randomBytes(32))]));
    const r = await verifyDisclosure(d, { published: wrongRoots });
    expect(r.checks.find((x) => x.name === "published")).toMatchObject({ ok: false });
  });

  it("is refused when it was sealed before the statement was made", async () => {
    const key = await vaultSigningKey(VAULT);
    const statement: DisclosureStatement = { origin: ORIGIN, periodSeconds: PERIOD, signingKey: key.publicKey, issuedAt: "2026-11-20T10:00:00.000Z", claim: fieldClaim(commitFields(memoryFields(passport)), 0) };
    const d = { ...signDisclosure(key, statement), anchor: anchorFor(statement, new Date("2026-11-19T10:00:00.000Z")) };
    expect((await verifyDisclosure(d)).checks.find((x) => x.name === "anchor")?.ok).toBe(false);
  });
});
