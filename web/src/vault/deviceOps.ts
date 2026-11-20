// Adding a device by QR code or short code, signing in with a paired device,
// and quick capture into the inbox. The vault key travels only sealed to the
// new device's one-time key; captures are sealed to the vault public key on
// the phone, before they are sent.

import {
  AAD,
  cleanProposal,
  codeMatchesKey,
  decryptJson,
  deviceKeys,
  deviceNameFrom,
  encryptJson,
  newDeviceId,
  newDeviceSecret,
  newPairing,
  normalizePairingCode,
  openDeviceGift,
  pairingUrl,
  parsePairingFragment,
  randomId,
  sealDeviceGift,
  sealProposal,
  toBase64Url,
  unwrapVaultKey,
  vaultCryptoKey,
  decodeBoxPublicKey,
  wrapVaultKey,
  type BoxKeyPair,
  type ProposalDraft,
} from "@sigil/core";
import type { Api } from "./api";
import type { KeyslotView, Unlocked } from "./ops";
import { deriveFromDevice, dropCaptures, queueCapture, queuedCaptures, rememberKeyslot, saveDevice, thisDevice } from "./offline";

// ---------------------------------------------------------------- the new device

export interface PairingSession {
  id: string;
  pair: BoxKeyPair;
  publicKey: string;
  code: string;
  pollSecret: string;
  url: string;
  expiresAt: string;
}

export async function startPairing(api: Api, origin: string): Promise<PairingSession> {
  const p = newPairing();
  const id = randomId();
  const r = await api.post<{ expiresAt: string }>("devices/pairings", { id, publicKey: p.publicKey, code: p.code, pollSecret: p.pollSecret });
  return { id, pair: p.pair, publicKey: p.publicKey, code: p.code, pollSecret: p.pollSecret, url: pairingUrl(origin, id, p.publicKey), expiresAt: r.expiresAt };
}

/** Asks the relay for the sealed keys. Null while the other device has not sent them; an error once the code is gone. */
export async function pollPairing(api: Api, s: PairingSession): Promise<ReturnType<typeof openDeviceGift> | null> {
  const r = await api.post<{ state: "waiting" | "ready" | "gone"; sealed?: string }>(`devices/pairings/${s.id}/poll`, { pollSecret: s.pollSecret });
  if (r.state === "waiting") return null;
  if (r.state === "gone" || !r.sealed) throw new Error("This code expired or was used. Make a new one.");
  return openDeviceGift(s.pair, s.id, r.sealed);
}

/**
 * Signs in with the device's own key slot, checks it opens the same vault key
 * that arrived sealed, and keeps the device key in this browser.
 */
export async function finishPairing(api: Api, gift: ReturnType<typeof openDeviceGift>): Promise<Unlocked> {
  const keys = await deviceKeys(gift.deviceSecret);
  const r = await api.post<{ keyslot: { wrappedKey: string } }>("auth/device/login", { deviceId: gift.deviceId, authToken: keys.authToken });
  const raw = await unwrapVaultKey(keys.kek, r.keyslot.wrappedKey, "device");
  if (toBase64Url(raw) !== toBase64Url(gift.vaultKey)) throw new Error("The keys from the other device do not open this vault.");
  await saveDevice(gift.deviceId, gift.deviceSecret, gift.name);
  rememberKeyslot({ kind: "device", wrappedKey: r.keyslot.wrappedKey, deviceId: gift.deviceId });
  gift.deviceSecret.fill(0);
  return { raw, key: await vaultCryptoKey(raw) };
}

export class DeviceRevoked extends Error {
  constructor() {
    super("This device was removed from the vault. Its key was forgotten here; add it again from a signed-in device.");
    this.name = "DeviceRevoked";
  }
}

/** Opens the vault with the device key kept in this browser. */
export async function signInWithDevice(api: Api): Promise<Unlocked> {
  const d = await thisDevice();
  if (!d) throw new Error("This browser holds no device key.");
  const authToken = toBase64Url(await deriveFromDevice(d.key, "sigil:auth:device"));
  let r: { keyslot: { wrappedKey: string } };
  try {
    r = await api.post("auth/device/login", { deviceId: d.deviceId, authToken });
  } catch (err) {
    if ((err as { code?: string }).code === "unknown_device") {
      const { forgetDevice } = await import("./offline");
      await forgetDevice();
      throw new DeviceRevoked();
    }
    throw err;
  }
  const kek = await deriveFromDevice(d.key, "sigil:kek:device");
  rememberKeyslot({ kind: "device", wrappedKey: r.keyslot.wrappedKey, deviceId: d.deviceId });
  const raw = await unwrapVaultKey(kek, r.keyslot.wrappedKey, "device");
  return { raw, key: await vaultCryptoKey(raw) };
}

// ---------------------------------------------------------------- the signed-in device

export interface PairingTarget {
  id: string;
  publicKey: string;
  code: string;
}

/** Looks a new device up by the code typed in, and checks the key the server returned was the one the code was made from. */
export async function findByCode(api: Api, typed: string): Promise<PairingTarget> {
  const code = normalizePairingCode(typed);
  if (!code) throw new Error("A code is ten letters and digits, like 7KQ2M-9XD4P.");
  const r = await api.get<{ id: string; publicKey: string }>(`devices/pairings?code=${encodeURIComponent(code)}`);
  if (!codeMatchesKey(code, r.publicKey)) throw new Error("The server answered with a key that does not belong to this code. Nothing was sent.");
  return { id: r.id, publicKey: r.publicKey, code };
}

/** From the QR code (a link to /vault/pair#...): the key comes from the code itself, the server only confirms the pairing is open. */
export async function findByLink(api: Api, fragment: string): Promise<PairingTarget> {
  const { pairingId, publicKey } = parsePairingFragment(fragment);
  const r = await api.get<{ id: string; publicKey: string; code: string }>(`devices/pairings/${pairingId}`);
  if (r.publicKey !== publicKey || !codeMatchesKey(r.code, publicKey)) throw new Error("This code does not match the device that is waiting. Nothing was sent.");
  return { id: pairingId, publicKey, code: r.code };
}

/**
 * Makes a key slot for the new device and sends it the vault key and its
 * device secret, sealed to its one-time key.
 */
export async function sendToDevice(api: Api, vault: Unlocked, target: PairingTarget, name: string): Promise<KeyslotView[]> {
  const deviceId = newDeviceId();
  const secret = newDeviceSecret();
  const keys = await deviceKeys(secret);
  const clean = name.trim().slice(0, 80) || "New device";
  const sealed = sealDeviceGift(target.publicKey, target.id, { v: 1, vaultKey: toBase64Url(vault.raw), deviceId, deviceSecret: toBase64Url(secret), name: clean });
  const r = await api.post<{ keyslots: KeyslotView[] }>(`devices/pairings/${target.id}/send`, {
    sealed,
    deviceId,
    authToken: keys.authToken,
    wrappedKey: await wrapVaultKey(keys.kek, vault.raw, "device"),
    note: await encryptJson(vault.key, { name: clean }, AAD.keyslotNote(deviceId)),
  });
  secret.fill(0);
  return r.keyslots;
}

export async function deviceName(vault: Unlocked, slot: KeyslotView): Promise<string> {
  if (!slot.note || !slot.label) return "A device";
  try {
    return (await decryptJson<{ name: string }>(vault.key, slot.note, AAD.keyslotNote(slot.label))).name;
  } catch {
    return "A device";
  }
}

export async function revokeDevice(api: Api, keyslotId: string): Promise<KeyslotView[]> {
  return (await api.del<{ keyslots: KeyslotView[] }>(`devices/${keyslotId}`)).keyslots;
}

export function defaultDeviceName(): string {
  return typeof navigator === "undefined" ? "New device" : deviceNameFrom(navigator.userAgent);
}

// ---------------------------------------------------------------- quick capture

const PINNED = "sigil:vault-public-key";

/** The vault public key as this device last saw it while the vault was open. */
export function pinVaultKey(publicKey: string | null): void {
  try {
    if (publicKey) localStorage.setItem(PINNED, publicKey);
  } catch {
    // Without storage the capture screen asks for the vault to be opened once.
  }
}

export function pinnedVaultKey(): string | null {
  try {
    return localStorage.getItem(PINNED);
  } catch {
    return null;
  }
}

/**
 * Seals a capture on this device to the vault public key and puts it in the
 * inbox. The vault does not need to be open: the key is public, and it is
 * checked against the one this device pinned when the vault was last open.
 */
export async function capture(api: Api, draft: ProposalDraft, pinned: string | null = pinnedVaultKey()): Promise<{ id: string; queued: boolean }> {
  let publicKey: string;
  try {
    publicKey = (await api.get<{ publicKey: string }>("capture/key")).publicKey;
  } catch (err) {
    // Offline: seal with the key this device pinned and send it once the network is back.
    if ((err as { status?: number }).status === 0 && pinned) {
      const sealed = sealCapture(draft, pinned);
      await queueCapture(sealed);
      return { id: sealed.id, queued: true };
    }
    throw err;
  }
  if (pinned && pinned !== publicKey) throw new Error("The server sent a different vault key than this device knows, so nothing was sent. Open your vault on this device and try again.");
  const sealed = sealCapture(draft, publicKey);
  await api.post("capture", sealed);
  return { id: sealed.id, queued: false };
}

export function sealCapture(draft: ProposalDraft, publicKey: string): { id: string; sealed: string } {
  const id = randomId();
  return { id, sealed: sealProposal(decodeBoxPublicKey(publicKey), id, "capture", cleanProposal(draft, "capture")) };
}

/** Sends captures that were sealed while offline. Returns how many went. */
export async function flushCaptures(api: Api): Promise<number> {
  const waiting = await queuedCaptures();
  let sent = 0;
  for (const c of waiting) {
    try {
      await api.post("capture", c);
      sent++;
    } catch (err) {
      // Still offline: keep the rest for next time. Anything the server refused is dropped.
      if ((err as { status?: number }).status === 0) break;
      sent++;
    }
  }
  await dropCaptures(sent);
  return sent;
}

/** Shrinks a photo on this device before it is sealed: longest side 1600 pixels, JPEG. */
export async function shrinkPhoto(file: Blob, max = 1600, quality = 0.82): Promise<{ type: "image/jpeg"; data: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot read photos.");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const url = canvas.toDataURL("image/jpeg", quality);
  return { type: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
}
