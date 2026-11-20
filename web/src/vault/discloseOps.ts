// Proofs of a fact, made on the owner's device: the claim and its evidence are
// put together here and signed with the vault's signing key; only the
// statement's hash goes to the server for the log. Once that hour is sealed,
// the proof is completed with the sealed entry and can be downloaded or shared
// by link. The proof itself is kept under the vault key.

import {
  AAD,
  beforeClaim,
  commitFields,
  decryptJson,
  encryptJson,
  fieldClaim,
  historyClaim,
  memoryFields,
  randomId,
  signDisclosure,
  statementHash,
  vaultSigningKey,
  type CertificateHour,
  type Claim,
  type Disclosure,
  type Memory,
  type SealedEntry,
} from "@sigil/core";
import type { Api } from "./api";
import type { Unlocked } from "./ops";

export interface ServerDisclosure {
  id: string;
  box: string;
  published: boolean;
  createdAt: string;
}

export interface DisclosureView {
  id: string;
  published: boolean;
  createdAt: string;
  proof: Disclosure | null;
}

export async function openDisclosures(vault: Unlocked, rows: ServerDisclosure[]): Promise<{ disclosures: DisclosureView[]; unreadable: number }> {
  let unreadable = 0;
  const disclosures: DisclosureView[] = [];
  for (const r of rows) {
    let proof: Disclosure | null = null;
    try {
      proof = await decryptJson<Disclosure>(vault.key, r.box, AAD.disclosure(r.id));
    } catch {
      unreadable++;
    }
    disclosures.push({ id: r.id, published: r.published, createdAt: r.createdAt, proof });
  }
  return { disclosures, unreadable };
}

interface PresenceProofs {
  origin: string;
  periodSeconds: number;
  hours: CertificateHour[];
}

/** Signs a claim and writes its hash into the log. */
async function make(api: Api, vault: Unlocked, claim: Claim, base: { origin: string; periodSeconds: number }): Promise<DisclosureView> {
  const key = await vaultSigningKey(vault.raw);
  const d = signDisclosure(key, { origin: base.origin, periodSeconds: base.periodSeconds, signingKey: key.publicKey, issuedAt: new Date().toISOString(), claim });
  const id = randomId();
  const r = await api.post<{ disclosure: ServerDisclosure }>("disclosures", { id, hash: statementHash(d.statement), box: await encryptJson(vault.key, d, AAD.disclosure(id)) });
  return { id, published: false, createdAt: r.disclosure.createdAt, proof: d };
}

async function site(api: Api): Promise<PresenceProofs> {
  return api.get<PresenceProofs>("proof/presence");
}

export type FieldMode = { kind: "field" } | { kind: "before"; date: string; years: number | null };

/** A claim about one field of one memory: the field revealed, or a date in it compared with a day. */
export async function proveField(api: Api, vault: Unlocked, memory: Memory, fieldIndex: number, mode: FieldMode): Promise<DisclosureView> {
  const commitment = commitFields(memoryFields(memory));
  const claim = mode.kind === "field" ? fieldClaim(commitment, fieldIndex) : beforeClaim(commitment, fieldIndex, mode.date, mode.years);
  const s = await site(api);
  return make(api, vault, claim, s);
}

/** A claim of months of sealed history, from the first and the latest sealed presence. */
export async function proveHistory(api: Api, vault: Unlocked): Promise<DisclosureView> {
  const s = await site(api);
  if (s.hours.length < 2) throw new Error("There is not enough sealed presence yet: keep using the vault, and come back after the first month.");
  return make(api, vault, historyClaim(s.hours[0], s.hours[s.hours.length - 1], s.periodSeconds), s);
}

/** A claim of membership in a team space since the vault joined it. */
export async function proveMember(api: Api, vault: Unlocked, space: { id: string; name: string }): Promise<DisclosureView> {
  const { entry } = await api.get<{ entry: SealedEntry | null }>(`proof/space/${space.id}`);
  if (!entry) throw new Error("The record of joining this space is not sealed yet, or was made before this kind of proof existed. Try again once the hour is over.");
  const s = await site(api);
  return make(api, vault, { kind: "member", space: space.id, label: space.name, entry }, s);
}

/** Adds the sealed entry once its hour is over. Returns the same view while it is not sealed yet. */
export async function complete(api: Api, vault: Unlocked, view: DisclosureView): Promise<DisclosureView> {
  if (!view.proof || view.proof.anchor) return view;
  const { anchor } = await api.get<{ anchor: SealedEntry | null }>(`disclosures/${view.id}/anchor`);
  if (!anchor) return view;
  const proof = { ...view.proof, anchor };
  await api.put(`disclosures/${view.id}`, { box: await encryptJson(vault.key, proof, AAD.disclosure(view.id)) });
  return { ...view, proof };
}

export async function publish(api: Api, view: DisclosureView): Promise<void> {
  if (!view.proof?.anchor) throw new Error("The proof is not sealed yet.");
  await api.put(`disclosures/${view.id}/publish`, { proof: JSON.stringify(view.proof) });
}

export async function unpublish(api: Api, id: string): Promise<void> {
  await api.del(`disclosures/${id}/publish`);
}

export async function remove(api: Api, id: string): Promise<void> {
  await api.del(`disclosures/${id}`);
}

export function proofLink(origin: string, id: string): string {
  return `${origin.replace(/\/$/, "")}/verify?proof=${id}`;
}
