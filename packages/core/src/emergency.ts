// Emergency access: a medical card the owner builds from chosen health
// memories, edits, and publishes behind a short link for the lock screen.
//
// The card is encrypted on the device with a fresh 32-byte key (AES-256-GCM,
// AAD "sigil:emergency:<card id>"). The key lives only in the link, after the
// "#": /e/<card id>#<key>. Browsers never send the part after "#" to a server,
// so Sigil stores ciphertext it cannot read, and anyone who scans the code on
// the lock screen can. The owner keeps the key and the card under the vault
// key to show the code again; re-issuing makes a new id and a new key, so the
// old code opens nothing.

import { decryptJson, encryptJson, importKey, randomBytes } from "./crypto";
import { fromBase64Url, toBase64Url } from "./encoding";

export const EMERGENCY_AAD = (cardId: string) => `sigil:emergency:${cardId}`;
export const EMERGENCY_OWNER_AAD = (cardId: string) => `sigil:emergency-owner:${cardId}`;

export interface EmergencyContact {
  name: string;
  phone: string;
  relation: string;
}

export interface EmergencyCard {
  v: 1;
  name: string;
  bloodType: string;
  allergies: string;
  medication: string;
  conditions: string;
  contacts: EmergencyContact[];
  /** The languages the owner speaks, for a responder. */
  language: string;
  notes: string;
  updatedAt: string;
}

export const BLOOD_TYPES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;

export const EMPTY_CARD: EmergencyCard = { v: 1, name: "", bloodType: "", allergies: "", medication: "", conditions: "", contacts: [], language: "", notes: "", updatedAt: "" };

const text = (v: unknown, max: number) => String(v ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);
const line = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function cleanCard(value: unknown): EmergencyCard {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const blood = line(v.bloodType, 24).toUpperCase().replace(/\s/g, "").replace(/POS(ITIVE)?$/, "+").replace(/NEG(ATIVE)?$/, "-");
  return {
    v: 1,
    name: line(v.name, 80),
    bloodType: (BLOOD_TYPES as readonly string[]).includes(blood) ? blood : "",
    allergies: text(v.allergies, 600),
    medication: text(v.medication, 600),
    conditions: text(v.conditions, 600),
    contacts: (Array.isArray(v.contacts) ? v.contacts : [])
      .slice(0, 4)
      .map((c) => {
        const x = (c ?? {}) as Record<string, unknown>;
        return { name: line(x.name, 80), phone: line(x.phone, 40).replace(/[^0-9+()\- ]/g, ""), relation: line(x.relation, 40) };
      })
      .filter((c) => c.name || c.phone),
    language: line(v.language, 120),
    notes: text(v.notes, 600),
    updatedAt: typeof v.updatedAt === "string" && Number.isFinite(Date.parse(v.updatedAt)) ? v.updatedAt : new Date().toISOString(),
  };
}

export function cardIsEmpty(c: EmergencyCard): boolean {
  return !c.bloodType && !c.allergies && !c.medication && !c.conditions && c.contacts.length === 0 && !c.language && !c.notes;
}

// ---------------------------------------------------------------- from health memories

const PATTERNS: [keyof EmergencyCard, RegExp][] = [
  ["bloodType", /^\s*blood(\s*type|\s*group)?\s*[:=]\s*(.+)$/i],
  ["allergies", /^\s*allerg(y|ies|ic to)\s*[:=]\s*(.+)$/i],
  ["medication", /^\s*(medication|medications|medicine|medicines|meds|takes)\s*[:=]\s*(.+)$/i],
  ["conditions", /^\s*(condition|conditions|diagnosis|diagnoses)\s*[:=]\s*(.+)$/i],
  ["language", /^\s*(language|languages|speaks)\s*[:=]\s*(.+)$/i],
];
const CONTACT = /^\s*(emergency\s*contact|ice|in case of emergency)\s*[:=]\s*(.+)$/i;
const PHONE = /(\+?[0-9][0-9 ()-]{5,}[0-9])/;

/**
 * A first card from the memories the owner picked: lines such as "Blood type: A+",
 * "Allergies: penicillin", "Medication: ...", "Conditions: ...", "Language: ..." and
 * "Emergency contact: Name, relation, +46 ...". The owner edits it before it is published.
 */
export function cardFromMemories(memories: { title: string; body: string }[], base: Partial<EmergencyCard> = {}): EmergencyCard {
  const found: Record<string, string[]> = {};
  const contacts: EmergencyContact[] = [];
  for (const m of memories) {
    for (const raw of `${m.title}\n${m.body}`.split("\n")) {
      const c = CONTACT.exec(raw);
      if (c) {
        const rest = c[2].trim();
        const phone = PHONE.exec(rest)?.[1]?.trim() ?? "";
        const parts = rest.replace(phone, "").split(/[,;]/).map((p) => p.trim()).filter(Boolean);
        contacts.push({ name: parts[0] ?? "", relation: parts[1] ?? "", phone });
        continue;
      }
      for (const [field, re] of PATTERNS) {
        const hit = re.exec(raw);
        if (hit) (found[field] ??= []).push(hit[2].trim());
      }
    }
  }
  const join = (k: string) => [...new Set(found[k] ?? [])].join("\n");
  return cleanCard({
    ...base,
    bloodType: found.bloodType?.[0] ?? base.bloodType ?? "",
    allergies: join("allergies") || base.allergies,
    medication: join("medication") || base.medication,
    conditions: join("conditions") || base.conditions,
    language: found.language?.[0] ?? base.language ?? "",
    contacts: contacts.length ? contacts : (base.contacts ?? []),
  });
}

// ---------------------------------------------------------------- the key in the link

export function newCardKey(): Uint8Array {
  return randomBytes(32);
}

export async function sealCard(key: Uint8Array, cardId: string, card: EmergencyCard): Promise<string> {
  return encryptJson(await importKey(key), cleanCard(card), EMERGENCY_AAD(cardId));
}

export async function openCard(key: Uint8Array, cardId: string, envelope: string): Promise<EmergencyCard> {
  return cleanCard(await decryptJson(await importKey(key), envelope, EMERGENCY_AAD(cardId)));
}

export function cardUrl(origin: string, cardId: string, key: Uint8Array): string {
  return `${origin.replace(/\/$/, "")}/e/${cardId}#${toBase64Url(key)}`;
}

/** The key from the part of the link after "#". Null when it is missing or damaged. */
export function cardKeyFromFragment(hash: string): Uint8Array | null {
  const h = hash.replace(/^#/, "").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(h)) return null;
  try {
    const k = fromBase64Url(h);
    return k.length === 32 ? k : null;
  } catch {
    return null;
  }
}

/** A device class from a user agent string, and nothing more: no version, no model. */
export function coarseDevice(userAgent: string | null | undefined): "phone" | "tablet" | "computer" | "unknown" {
  const ua = (userAgent ?? "").toLowerCase();
  if (!ua) return "unknown";
  if (/ipad|tablet|kindle|silk/.test(ua) || (/android/.test(ua) && !/mobile/.test(ua))) return "tablet";
  if (/iphone|android|mobile|phone/.test(ua)) return "phone";
  return "computer";
}

/** The first language a browser asks for, as two letters, or an empty string. */
export function coarseLanguage(acceptLanguage: string | null | undefined): string {
  const m = /^\s*([a-zA-Z]{2,3})\b/.exec(acceptLanguage ?? "");
  return m ? m[1].toLowerCase().slice(0, 3) : "";
}
