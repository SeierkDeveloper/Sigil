// The emergency card on the owner's device: drafted from the health memories
// the owner picks, edited, and encrypted here under a fresh key that only the
// link carries. The owner's copy (the key and the card) is kept under the vault
// key, so the code can be shown again; re-issuing makes a new id and key.

import {
  cardFromMemories,
  cardUrl,
  cleanCard,
  decryptJson,
  EMERGENCY_OWNER_AAD,
  encryptJson,
  fromBase64Url,
  newCardKey,
  randomId,
  sealCard,
  toBase64Url,
  type EmergencyCard,
  type Memory,
} from "@sigil/core";
import type { Api } from "./api";
import type { Unlocked, VaultData } from "./ops";

export interface ServerEmergency {
  card: { id: string; ownerBox: string; createdAt: string; updatedAt: string } | null;
  opens: EmergencyOpen[];
}

export interface EmergencyOpen {
  cardId: string;
  at: string;
  device: string;
  lang: string;
}

export interface EmergencyView {
  card: { id: string; key: Uint8Array; card: EmergencyCard; createdAt: string; updatedAt: string } | null;
  opens: EmergencyOpen[];
}

export async function openEmergency(vault: Unlocked, server: ServerEmergency | undefined): Promise<{ emergency: EmergencyView; unreadable: number }> {
  const opens = server?.opens ?? [];
  if (!server?.card) return { emergency: { card: null, opens }, unreadable: 0 };
  try {
    const own = await decryptJson<{ key: string; card: unknown }>(vault.key, server.card.ownerBox, EMERGENCY_OWNER_AAD(server.card.id));
    return {
      emergency: { card: { id: server.card.id, key: fromBase64Url(own.key), card: cleanCard(own.card), createdAt: server.card.createdAt, updatedAt: server.card.updatedAt }, opens },
      unreadable: 0,
    };
  } catch {
    return { emergency: { card: null, opens }, unreadable: 1 };
  }
}

/** The memories offered for the card: those in health folders first, then the rest. */
export function healthMemories(data: Pick<VaultData, "memories" | "folders">): { memory: Memory; health: boolean }[] {
  const health = new Set(data.folders.filter((f) => f.protect === "health").map((f) => f.id));
  return data.memories
    .filter((m) => m.source.kind !== "brief" && m.source.kind !== "profile")
    .map((m) => ({ memory: m, health: health.has(m.folderId) }))
    .sort((a, b) => Number(b.health) - Number(a.health));
}

export function draftFrom(memories: Memory[], current: EmergencyCard | null): EmergencyCard {
  return cardFromMemories(memories, current ?? {});
}

/** Publishes the card. With `reissue`, or the first time, a new id and key: the old link stops working. */
export async function publishCard(api: Api, vault: Unlocked, view: EmergencyView, input: EmergencyCard, reissue = false): Promise<EmergencyView> {
  const keep = view.card && !reissue ? view.card : null;
  const id = keep?.id ?? randomId();
  const key = keep?.key ?? newCardKey();
  const card = cleanCard({ ...input, updatedAt: new Date().toISOString() });
  const r = await api.put<{ card: { id: string; createdAt: string; updatedAt: string } }>("emergency", {
    id,
    card: await sealCard(key, id, card),
    ownerBox: await encryptJson(vault.key, { key: toBase64Url(key), card }, EMERGENCY_OWNER_AAD(id)),
  });
  return { ...view, card: { id, key, card, createdAt: r.card.createdAt, updatedAt: r.card.updatedAt } };
}

export async function revokeCard(api: Api, view: EmergencyView): Promise<EmergencyView> {
  await api.del("emergency");
  return { ...view, card: null };
}

export async function refreshOpens(api: Api): Promise<EmergencyOpen[]> {
  return (await api.get<{ opens: EmergencyOpen[] }>("emergency/opens")).opens;
}

export function emergencyLink(origin: string, view: EmergencyView): string | null {
  return view.card ? cardUrl(origin, view.card.id, view.card.key) : null;
}
