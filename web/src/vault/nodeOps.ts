// Moving the vault to another node, on the owner's device. On the old node the
// device signs a bundle and a move statement and gets a move code; on the new
// node the owner signs in with the bundle's own key slot, the device opens and
// checks the bundle, and signs a restore statement for the new node and an
// arrival for the old one.

import {
  formatMoveCode,
  moveUrl,
  newMoveId,
  newMoveSecret,
  nodeOrigin,
  parseMoveCode,
  sha256Hex,
  signArrival,
  signMove,
  vaultSigningKey,
  MOVE_DEFAULT_DAYS,
  type SignedMove,
  type VaultBundle,
} from "@sigil/core";
import type { Api } from "./api";
import type { Unlocked } from "./ops";
import { makeBundle, openForRestore, restoreHere, type OpenedForRestore, type RestoreResult, type RestoreSignIn } from "./storageOps";

export interface NodeRow {
  id: string;
  origin: string;
  role: "previous" | "next";
  moveId: string | null;
  state: "waiting" | "confirmed";
  since: string;
  until: string | null;
}

export interface MoveRow {
  id: string;
  to: string;
  state: "signed" | "sent" | "done" | "cancelled";
  bundle: string;
  createdAt: string;
  sentAt: string | null;
  doneAt: string | null;
}

export interface NodesView {
  here: string;
  nodes: NodeRow[];
  moves: MoveRow[];
}

export const NO_NODES: NodesView = { here: "", nodes: [], moves: [] };

export interface StartedMove {
  id: string;
  code: string;
  url: string;
}

/** Signs a move to another node and leaves the bundle with this node for the new one to fetch with the code. */
export async function startMove(api: Api, vault: Unlocked, here: string, to: string, redirectDays = MOVE_DEFAULT_DAYS): Promise<StartedMove> {
  const target = nodeOrigin(to);
  const from = nodeOrigin(here);
  if (target === from) throw new Error("That is this node. Give the address of the node to move to.");
  const bundle = await makeBundle(api, vault);
  const key = await vaultSigningKey(vault.raw);
  const id = newMoveId();
  const secret = newMoveSecret();
  const move = signMove(key, { id, from, to: target, bundle: bundle.hash, redirectDays, issuedAt: new Date().toISOString() });
  await api.post("nodes/moves", { move, secretHash: sha256Hex(secret), bundle });
  const code = formatMoveCode({ from, id, secret });
  return { id, code, url: moveUrl(target, code) };
}

export async function cancelMove(api: Api, id: string): Promise<void> {
  await api.del(`nodes/moves/${id}`);
}

/** On the new node: the move and its bundle, fetched by this node from the old one with the code. */
export async function fetchArrival(api: Api, code: string): Promise<{ move: SignedMove; bundle: VaultBundle }> {
  parseMoveCode(code);
  return api.post<{ move: SignedMove; bundle: VaultBundle }>("nodes/arrive", { code });
}

/** On the new node: opens the bundle with the owner's sign-in, restores it here and tells the old node, with an arrival the vault key signs. */
export async function arrive(api: Api, code: string, move: SignedMove, bundle: VaultBundle, how: RestoreSignIn, origin: string): Promise<{ opened: OpenedForRestore; result: RestoreResult }> {
  if (move.statement.to !== nodeOrigin(origin)) throw new Error(`This move is for ${move.statement.to}, not this node.`);
  const opened = await openForRestore(bundle, how);
  const key = await vaultSigningKey(opened.vault.raw);
  if (key.publicKey !== move.statement.vault) throw new Error("This move belongs to another vault.");
  const at = new Date().toISOString();
  const signature = signArrival(key, move.statement.id, move.statement.to, bundle.hash, at);
  const result = await restoreHere(api, opened, bundle, origin, { code, at, signature, redirectDays: move.statement.redirectDays });
  return { opened, result };
}

/** Tells the old node again, when it could not be reached at the time of the move. */
export async function notifyOldNode(api: Api, rowId: string): Promise<boolean> {
  return (await api.post<{ confirmed: boolean }>(`nodes/${rowId}/notify`)).confirmed;
}
