// Capture keys, on the owner's device: one per phone, watch or shortcut. The
// vault makes the key, a tag over its public key that the device checks before
// sealing, and a name for the key under the vault key. The key itself is shown
// once and is never stored anywhere but where the owner puts it.

import {
  AAD,
  captureBoxTag,
  captureLink,
  captureToken,
  decryptJson,
  encryptJson,
  formatCaptureKey,
  newCaptureKey,
  parseCaptureKey,
  sealWithCaptureKey,
  tokenHash,
  type ProposalDraft,
} from "@sigil/core";
import type { Api, Fetcher } from "./api";
import type { Unlocked } from "./ops";

export interface ServerCaptureKey {
  id: string;
  note: string;
  plain: boolean;
  sent: number;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CaptureKeyView extends Omit<ServerCaptureKey, "note"> {
  name: string;
}

export async function openCaptureKeys(vault: Unlocked, rows: ServerCaptureKey[]): Promise<{ keys: CaptureKeyView[]; unreadable: number }> {
  let unreadable = 0;
  const keys: CaptureKeyView[] = [];
  for (const { note, ...r } of rows) {
    let name = "A capture key";
    try {
      name = (await decryptJson<{ name: string }>(vault.key, note, AAD.captureNote(r.id))).name;
    } catch {
      unreadable++;
    }
    keys.push({ ...r, name });
  }
  return { keys, unreadable };
}

export interface NewCaptureKey {
  id: string;
  key: string;
  /** The capture page with the key after #, for a shortcut that opens a link. */
  link: string;
}

export async function makeCaptureKey(api: Api, vault: Unlocked, boxPublic: string | null, name: string, plain: boolean, origin: string): Promise<{ made: NewCaptureKey; keys: ServerCaptureKey[] }> {
  if (!boxPublic) throw new Error("This vault has no public key yet. Reload the vault and try again.");
  const k = newCaptureKey();
  const token = await captureToken(k.secret);
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 80) || "A capture key";
  const r = await api.post<{ captureKeys: ServerCaptureKey[] }>("capture-keys", {
    id: k.id,
    tokenHash: tokenHash(token),
    tag: await captureBoxTag(k.secret, boxPublic),
    note: await encryptJson(vault.key, { name: clean }, AAD.captureNote(k.id)),
    plain,
  });
  const key = formatCaptureKey(k.id, k.secret);
  return { made: { id: k.id, key, link: captureLink(origin, key) }, keys: r.captureKeys };
}

export async function revokeCaptureKey(api: Api, id: string): Promise<ServerCaptureKey[]> {
  return (await api.del<{ captureKeys: ServerCaptureKey[] }>(`capture-keys/${id}`)).captureKeys;
}

/**
 * Sends one capture with a capture key, from any device: fetches the vault
 * public key and its tag, checks the tag, seals here, and sends the box.
 */
export async function sendWithKey(keyText: string, draft: ProposalDraft, fetcher: Fetcher = (i, init) => fetch(i, init), base = ""): Promise<{ id: string }> {
  const key = parseCaptureKey(keyText);
  const authorization = `Bearer ${await captureToken(key.secret)}`;
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await fetcher(`${base}/api/capture/v1${path}`, { method, headers: { authorization, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error("Sigil could not be reached. Check your connection and try again.");
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `Sending failed (${res.status}).`);
    return data;
  };
  const vault = await call<{ publicKey: string; tag: string }>("GET", "/key");
  const sealed = await sealWithCaptureKey(key, vault, draft);
  await call("POST", "", sealed);
  return { id: sealed.id };
}

/** The request a shortcut that cannot run code sends, for a key allowed to send plain text. */
export function plainRequest(origin: string, token: string): { url: string; method: "POST"; headers: Record<string, string>; body: string } {
  return { url: `${origin.replace(/\/$/, "")}/api/capture/v1/text`, method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: '{"text": "<what you said>"}' };
}

/** The bearer token of a capture key, for the plain text request. Shown once, with the key. */
export async function tokenFor(keyText: string): Promise<string> {
  return captureToken(parseCaptureKey(keyText).secret);
}
