// Receipts of what the AI self does on its own, on the owner's device: each
// is signed by the self key here (derived from the vault key, never stored),
// kept on the server as an envelope under the vault key, and its fingerprint
// joins the hourly seal. The server never sees a receipt, only its salted hash.

import { AAD, decryptJson, encryptJson, parseReceipt, randomId, receiptLeaf, selfIdentityKey, signReceipt, type Receipt, type ReceiptKind, type SharedReceipt } from "@sigil/core";
import type { Api } from "./api";
import type { Unlocked } from "./ops";

export interface ServerReceipt {
  id: string;
  leaf: string;
  hour: number;
  box: string;
  sealed: boolean;
  createdAt: string;
  seal: { hour: number; root: string; proof: string[]; periodSeconds: number } | null;
}

export interface ReceiptView {
  id: string;
  leaf: string;
  sealed: boolean;
  createdAt: string;
  receipt: Receipt | null;
  /** What to share: the receipt, and where it was sealed once it is. */
  shared: SharedReceipt | null;
}

export async function openReceipts(vault: Unlocked, rows: ServerReceipt[]): Promise<ReceiptView[]> {
  const out: ReceiptView[] = [];
  for (const r of rows) {
    let receipt: Receipt | null = null;
    try {
      receipt = await decryptJson<Receipt>(vault.key, r.box, AAD.receipt(r.id));
    } catch {
      receipt = null;
    }
    out.push({
      id: r.id,
      leaf: r.leaf,
      sealed: r.sealed,
      createdAt: r.createdAt,
      receipt,
      shared: receipt ? { receipt, seal: r.seal ? { hour: r.seal.hour, proof: r.seal.proof, root: r.seal.root, periodSeconds: r.seal.periodSeconds } : null } : null,
    });
  }
  return out;
}

export async function loadReceipts(api: Api, vault: Unlocked): Promise<ReceiptView[]> {
  return openReceipts(vault, (await api.get<{ receipts: ServerReceipt[] }>("self/receipts")).receipts);
}

/** Signs a receipt with the self key and keeps it: the receipt under the vault key, its fingerprint for this hour's seal. */
export async function recordReceipt(
  api: Api,
  vault: Unlocked,
  input: { kind: ReceiptKind; what: string; limit: string; ref?: Record<string, string> },
  origin = typeof window !== "undefined" ? window.location.origin : "",
): Promise<ReceiptView> {
  const self = await selfIdentityKey(vault.raw);
  const receipt = signReceipt(self, { kind: input.kind, what: input.what, limit: input.limit, ref: input.ref ?? {}, origin });
  const id = randomId();
  const leaf = receiptLeaf(receipt);
  const r = await api.post<{ receipt: ServerReceipt }>("self/receipts", { id, leaf, box: await encryptJson(vault.key, receipt, AAD.receipt(id)) });
  return { id, leaf, sealed: r.receipt.sealed, createdAt: r.receipt.createdAt, receipt, shared: { receipt, seal: null } };
}

export async function deleteReceipt(api: Api, id: string): Promise<void> {
  await api.del(`self/receipts/${id}`);
}

/** The file an owner shares: the receipt and its seal, as JSON. */
export function receiptFile(view: ReceiptView): string {
  if (!view.shared) throw new Error("This receipt could not be opened with your key.");
  return JSON.stringify(view.shared, null, 2);
}

export { parseReceipt };
