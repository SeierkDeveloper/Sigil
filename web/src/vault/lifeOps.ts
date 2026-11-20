// Proof of a real life on the device: the vault's signing key, one signed
// presence statement per seal period while the vault is open, and
// certificates built and signed here from the sealed history.

import { buildCertificate, randomId, signPresence, vaultSigningKey, type CertificateHour, type LifeCertificate } from "@sigil/core";
import type { Api } from "./api";
import type { Unlocked } from "./ops";

export interface PresenceCounts {
  total: number;
  sealed: number;
  firstHour: number | null;
  lastHour: number | null;
}

export interface CertificateView {
  id: string;
  size: number;
  summary: { from: string; to: string; activeHours: number; activeDays: number; continuousMonths: number };
  createdAt: string;
}

/** Registers the vault's signing key the first time the vault is opened after this feature existed. */
export async function ensureSignKey(api: Api, vault: Unlocked, have: string | null): Promise<string | null> {
  const key = await vaultSigningKey(vault.raw);
  if (have) return have;
  try {
    await api.post("vault/sign-key", { publicKey: key.publicKey });
    return key.publicKey;
  } catch {
    return null;
  }
}

/** Signs this period's presence, once. Returns the period length so the caller knows how often to come back. */
export async function sendPresence(api: Api, vault: Unlocked): Promise<{ recorded: boolean; periodSeconds: number }> {
  const t = await api.get<{ hour: number; periodSeconds: number; origin: string; done: boolean; signingKey: string | null }>("presence");
  if (t.done || !t.signingKey) return { recorded: false, periodSeconds: t.periodSeconds };
  const key = await vaultSigningKey(vault.raw);
  if (key.publicKey !== t.signingKey) return { recorded: false, periodSeconds: t.periodSeconds };
  const r = await api.post<{ recorded: boolean }>("presence", { hour: t.hour, sig: signPresence(key, t.origin, t.hour, t.periodSeconds) });
  return { recorded: r.recorded, periodSeconds: t.periodSeconds };
}

/** Builds and signs a certificate from every sealed presence hour, on this device. */
export async function makeCertificate(api: Api, vault: Unlocked): Promise<LifeCertificate> {
  const r = await api.get<{ origin: string; periodSeconds: number; hours: CertificateHour[] }>("proof/presence");
  if (r.hours.length === 0) throw new Error("There is no sealed presence yet. Each hour your vault is open is sealed once that hour is over.");
  return buildCertificate(await vaultSigningKey(vault.raw), { origin: r.origin, periodSeconds: r.periodSeconds, hours: r.hours });
}

export async function publishCertificate(api: Api, cert: LifeCertificate): Promise<string> {
  const id = randomId();
  await api.post("certificates", { id, certificate: JSON.stringify(cert) });
  return id;
}

export async function unpublishCertificate(api: Api, id: string): Promise<void> {
  await api.del(`certificates/${id}`);
}

export function certificateLink(origin: string, id: string): string {
  return `${origin.replace(/\/$/, "")}/verify?certificate=${id}`;
}
