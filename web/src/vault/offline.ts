// What this device keeps, and only when the owner asks for it.
//
//   the copy for offline reading   the server's answer for /api/vault as it
//                                  came: ciphertext, wrapped keys, ids. Plus
//                                  the wrapped vault key for the way this
//                                  device last opened the vault, so it can be
//                                  opened again without the network.
//   the device key                 for a device added by QR code: its secret,
//                                  held as a key the page can use but never
//                                  read out (a non-extractable WebCrypto key).
//
// Both live in IndexedDB. Nothing here is readable without the passkey, the
// wallet, the recovery phrase or the device key. In tests and on the server
// every function does nothing.

import type { KeyslotKind } from "@sigil/core";
import type { ServerVault } from "./ops";

const DB = "sigil";
const STORE = "device";

export interface LastKeyslot {
  kind: KeyslotKind;
  wrappedKey: string;
  /** For a wallet: the address it signs with. */
  address?: string;
  /** For a paired device: its id. */
  deviceId?: string;
}

export interface OfflineCopy {
  savedAt: string;
  server: ServerVault;
  keyslot: LastKeyslot;
}

export interface DeviceRecord {
  deviceId: string;
  /** The device secret as a non-extractable HKDF key. */
  key: CryptoKey;
  name: string;
}

const hasIdb = () => typeof indexedDB !== "undefined";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(key: string, value: unknown): Promise<void> {
  if (!hasIdb()) return;
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    t.objectStore(STORE).put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  db.close();
}

async function get<T>(key: string): Promise<T | null> {
  if (!hasIdb()) return null;
  try {
    const db = await open();
    const out = await new Promise<T | null>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return out;
  } catch {
    return null;
  }
}

async function del(key: string): Promise<void> {
  if (!hasIdb()) return;
  const db = await open();
  await new Promise<void>((resolve) => {
    const t = db.transaction(STORE, "readwrite");
    t.objectStore(STORE).delete(key);
    t.oncomplete = () => resolve();
    t.onerror = () => resolve();
  });
  db.close();
}

// ---------------------------------------------------------------- the last way in

let last: LastKeyslot | null = null;

/** Called by every sign-in: the wrapped vault key for the way this device opened the vault. */
export function rememberKeyslot(k: LastKeyslot): void {
  last = k;
}

export function lastKeyslot(): LastKeyslot | null {
  return last;
}

// ---------------------------------------------------------------- the copy for offline reading

const FLAG = "sigil:offline-copy";

export function offlineWanted(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(FLAG) === "on";
  } catch {
    return false;
  }
}

export async function setOfflineWanted(on: boolean): Promise<void> {
  try {
    if (on) localStorage.setItem(FLAG, "on");
    else localStorage.removeItem(FLAG);
  } catch {
    // Storage refused: nothing is kept, which is the safe side.
  }
  if (!on) await del("copy");
}

/** Keeps the latest ciphertext of the vault, when the owner turned the copy on for this device. */
export async function saveOfflineCopy(server: ServerVault): Promise<void> {
  if (!offlineWanted() || !last) return;
  await put("copy", { savedAt: new Date().toISOString(), server, keyslot: last } satisfies OfflineCopy).catch(() => undefined);
}

export async function offlineCopy(): Promise<OfflineCopy | null> {
  return get<OfflineCopy>("copy");
}

// ---------------------------------------------------------------- the device key

export async function saveDevice(deviceId: string, secret: Uint8Array, name: string): Promise<void> {
  const key = await crypto.subtle.importKey("raw", secret.slice().buffer as ArrayBuffer, "HKDF", false, ["deriveBits"]);
  await put("device", { deviceId, key, name } satisfies DeviceRecord);
}

export async function thisDevice(): Promise<DeviceRecord | null> {
  return get<DeviceRecord>("device");
}

/** Forgets the device key and the offline copy: after a revoke, or when the owner asks. */
export async function forgetDevice(): Promise<void> {
  await del("device");
  await del("copy");
}

/** The same HKDF as @sigil/core, from the stored key, so the raw secret is never read back. */
export async function deriveFromDevice(key: CryptoKey, info: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode("sigil/hkdf/v1"), info: enc.encode(info) }, key, 256);
  return new Uint8Array(bits);
}
