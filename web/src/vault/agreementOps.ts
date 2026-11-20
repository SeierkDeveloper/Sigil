// Sealed agreements on the owner's device. The draft, the review and both
// signatures happen here: the text travels sealed to the other vault's box key,
// each side keeps its own copy under its own vault key, and the server checks
// only signatures against hashes. Before signing, this side checks that the
// document names this vault with its own keys, that the other side's signature
// is by the key the server holds for that vault, and that the hash is the
// document's.

import {
  AAD,
  agreementContext,
  agreementHash,
  cleanAgreementDoc,
  decodeBoxPublicKey,
  decryptJson,
  encryptJson,
  openSealedJson,
  parseVaultCode,
  randomId,
  sealJson,
  signAgreement,
  vaultSigningKey,
  verifyAgreementSignature,
  type AgreementDoc,
  type AgreementOffer,
  type BoxKeyPair,
  type SealedEntry,
  type SignedAgreement,
} from "@sigil/core";
import type { Api } from "./api";
import type { Unlocked, VaultData } from "./ops";

export type AgreementState = "proposed" | "signed" | "declined" | "withdrawn";

export interface ServerAgreement {
  id: string;
  role: "from" | "to";
  myKey: string;
  peerKey: string;
  mySignKey: string | null;
  peerSignKey: string | null;
  hash: string;
  version: number;
  previous: string | null;
  offer: string;
  box: string | null;
  fromSig: string;
  toSig: string | null;
  state: AgreementState;
  createdAt: string;
  signedAt: string | null;
}

export interface AgreementView extends Omit<ServerAgreement, "offer" | "box"> {
  doc: AgreementDoc | null;
  /** What this side found when it checked the document. Empty when all is well. */
  problems: string[];
}

/** Opens each agreement on this device: this side's own copy, or for one waiting to be signed, the sealed offer. */
export async function openAgreements(vault: Unlocked, box: BoxKeyPair | null, rows: ServerAgreement[]): Promise<{ agreements: AgreementView[]; unreadable: number }> {
  let unreadable = 0;
  const agreements: AgreementView[] = [];
  for (const r of rows) {
    const { offer: _o, box: own, ...rest } = r;
    let doc: AgreementDoc | null = null;
    try {
      if (own) doc = (await decryptJson<{ doc: AgreementDoc }>(vault.key, own, AAD.agreementOwner(r.id))).doc;
      else if (r.role === "to" && box) doc = openSealedJson<AgreementOffer>(box, r.offer, agreementContext(r.id)).doc;
    } catch {
      unreadable++;
    }
    agreements.push({ ...rest, doc, problems: doc ? problems(r, doc) : ["This agreement could not be opened with this vault's key."] });
  }
  return { agreements, unreadable };
}

function problems(r: ServerAgreement, doc: AgreementDoc): string[] {
  const out: string[] = [];
  let hash = "";
  try {
    hash = agreementHash(cleanAgreementDoc(doc));
  } catch (err) {
    out.push((err as Error).message);
  }
  if (hash && hash !== r.hash) out.push("The text does not match the hash that was signed.");
  const me = r.role === "from" ? 0 : 1;
  const peer = 1 - me;
  if (doc.parties[me]?.signingKey !== r.mySignKey || doc.parties[me]?.boxKey !== r.myKey) out.push("The document does not name this vault with its own keys.");
  if (doc.parties[peer]?.boxKey !== r.peerKey) out.push("The document names another vault than the one it came from.");
  if (r.peerSignKey && doc.parties[peer]?.signingKey !== r.peerSignKey) out.push("The other side's signing key is not the one this site holds for that vault.");
  if (!verifyAgreementSignature(doc.parties[0]?.signingKey ?? "", r.hash, r.fromSig)) out.push("The first signature does not check out.");
  if (r.toSig && !verifyAgreementSignature(doc.parties[1]?.signingKey ?? "", r.hash, r.toSig)) out.push("The second signature does not check out.");
  return out;
}

export interface ProposeInput {
  code: string;
  title: string;
  text: string;
  me: string;
  them: string;
}

async function send(api: Api, vault: Unlocked, data: Pick<VaultData, "boxPublic" | "signKey">, toKey: string, parts: Omit<AgreementDoc, "parties" | "nonce" | "createdAt"> & { me: string; them: string }): Promise<string> {
  if (!data.boxPublic || !data.signKey) throw new Error("This vault has no keys yet. Reload it and try again.");
  if (toKey === data.boxPublic) throw new Error("That is your own vault code.");
  const { signingKey } = await api.get<{ signingKey: string }>(`agreements/peer/${toKey}`);
  const doc = cleanAgreementDoc({
    title: parts.title,
    text: parts.text,
    version: parts.version,
    previous: parts.previous,
    parties: [
      { name: parts.me, boxKey: data.boxPublic, signingKey: data.signKey },
      { name: parts.them, boxKey: toKey, signingKey },
    ],
  });
  const hash = agreementHash(doc);
  const signature = signAgreement(await vaultSigningKey(vault.raw), hash);
  const id = randomId();
  await api.post("agreements", {
    id,
    toKey,
    hash,
    version: doc.version,
    previous: doc.previous,
    offer: sealJson(decodeBoxPublicKey(toKey), { v: 1, doc, signature } satisfies AgreementOffer, agreementContext(id)),
    box: await encryptJson(vault.key, { doc }, AAD.agreementOwner(id)),
    signature,
  });
  return id;
}

/** Drafts and sends an agreement to another vault, signed by this one. */
export async function propose(api: Api, vault: Unlocked, data: Pick<VaultData, "boxPublic" | "signKey">, input: ProposeInput): Promise<string> {
  return send(api, vault, data, parseVaultCode(input.code), { title: input.title, text: input.text, version: 1, previous: null, me: input.me, them: input.them });
}

/** An amendment: a new version that names the signed one it replaces. Sent to the same vault. */
export async function amend(api: Api, vault: Unlocked, data: Pick<VaultData, "boxPublic" | "signKey">, old: AgreementView, input: { title: string; text: string }): Promise<string> {
  if (old.state !== "signed" || !old.doc) throw new Error("Only a signed agreement can be amended.");
  const me = old.role === "from" ? 0 : 1;
  return send(api, vault, data, old.peerKey, { title: input.title, text: input.text, version: old.version + 1, previous: old.hash, me: old.doc.parties[me].name, them: old.doc.parties[1 - me].name });
}

/** Signs an agreement sent to this vault, after its checks. Keeps this side's own copy under the vault key. */
export async function sign(api: Api, vault: Unlocked, view: AgreementView): Promise<void> {
  if (view.role !== "to" || view.state !== "proposed") throw new Error("This agreement is not waiting for your signature.");
  if (!view.doc) throw new Error("This agreement could not be opened.");
  if (view.problems.length) throw new Error(view.problems[0]);
  const signature = signAgreement(await vaultSigningKey(vault.raw), view.hash);
  await api.post(`agreements/${view.id}/sign`, { signature, box: await encryptJson(vault.key, { doc: view.doc }, AAD.agreementOwner(view.id)) });
}

/** Declines one sent to this vault, or withdraws one this vault sent. */
export async function decline(api: Api, id: string): Promise<void> {
  await api.post(`agreements/${id}/decline`);
}

export async function remove(api: Api, id: string): Promise<void> {
  await api.del(`agreements/${id}`);
}

/** A verifiable copy: the document, both signatures and this vault's sealed entry, once its hour is sealed. */
export async function verifiableCopy(api: Api, view: AgreementView): Promise<SignedAgreement> {
  if (view.state !== "signed" || !view.doc || !view.toSig) throw new Error("Only a signed agreement has a verifiable copy.");
  const { seal } = await api.get<{ seal: SealedEntry | null }>(`agreements/${view.id}/seal`);
  return {
    format: "sigil-agreement",
    version: 1,
    doc: view.doc,
    hash: view.hash,
    signatures: [view.fromSig, view.toSig],
    seal: seal ? { ...seal, party: view.role === "from" ? 0 : 1 } : null,
  };
}
