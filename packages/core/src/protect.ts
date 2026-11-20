// Protected folders and redaction.
//
// A folder can be marked protected (health, money, legal or other). What it
// holds is never read by an app, an agent, the AI self or an ask link without a
// fresh yes from the owner for that read. The server knows only that the
// folder is protected (it holds back the ciphertext); what kind of folder it is
// stays in the folder's encrypted meta.
//
// Redaction masks patterns in text before anything leaves the vault: to an app
// through the connector, to a model, to a public page or to another vault's AI
// self. It runs where the keys are, on the device, per folder. Each rule is a
// pattern with a check where one exists (the Luhn check for card numbers,
// mod 97 for IBANs), so it masks the shape of the thing and nothing more: it
// can miss a number written in an unusual way, and it may mask a number that
// only looks like one.

import type { FolderGuard, RedactRule } from "./vault";

export const REDACT_LABELS: Record<RedactRule, string> = {
  card: "Card numbers",
  iban: "IBANs",
  account: "Account numbers",
  national_id: "National ID numbers",
  passport: "Passport numbers",
  phone: "Phone numbers",
  email: "Email addresses",
};

export const REDACT_MASKS: Record<RedactRule, string> = {
  card: "[card number hidden]",
  iban: "[IBAN hidden]",
  account: "[account number hidden]",
  national_id: "[ID number hidden]",
  passport: "[passport number hidden]",
  phone: "[phone number hidden]",
  email: "[email hidden]",
};

/** The order rules run in: the most specific shapes first, so a card number is not taken for an account number. */
const ORDER: RedactRule[] = ["email", "iban", "card", "national_id", "passport", "phone", "account"];

const digits = (s: string) => s.replace(/\D/g, "");

/** The Luhn check every payment card number passes. */
export function luhnValid(number: string): boolean {
  const d = digits(number);
  if (d.length < 12) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** The mod 97 check every IBAN passes. */
export function ibanValid(value: string): boolean {
  const s = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const code = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of code) rest = (rest * 10 + Number(c)) % 97;
  }
  return rest === 1;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const RULES: Record<RedactRule, (text: string, mask: string) => { text: string; n: number }> = {
  email: (text, mask) => replaceAll(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, () => mask),
  iban: (text, mask) => replaceAll(text, /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, (m) => (ibanValid(m) ? mask : null)),
  card: (text, mask) =>
    replaceAll(text, /\b\d(?:[ -]?\d){11,18}\b/g, (m) => {
      const n = digits(m).length;
      return n >= 13 && n <= 19 && luhnValid(m) ? mask : null;
    }),
  // Common shapes of national ID numbers: three, two and four digits with dashes;
  // a date of birth of six or eight digits, a dash or plus and four digits;
  // two letters, six digits and a letter.
  national_id: (text, mask) => {
    let n = 0;
    let out = text;
    for (const re of [/\b\d{3}-\d{2}-\d{4}\b/g, /\b(?:19|20)?\d{6}[-+]\d{4}\b/g, /\b[A-CEGHJ-PR-TW-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g]) {
      const r = replaceAll(out, re, () => mask);
      out = r.text;
      n += r.n;
    }
    return { text: out, n };
  },
  // A passport number is a short run of letters and digits; it is only taken as one after the word passport.
  passport: (text, mask) =>
    replaceAll(text, /\b(passport(?:\s+(?:no\.?|number|nr\.?|#))?\s*[:#]?\s*)([A-Z0-9]{6,9})\b/gi, (_m, groups) => `${groups[0]}${mask}`),
  phone: (text, mask) =>
    replaceAll(text, /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]?\d{2,4}){1,4}/g, (m) => {
      const t = m.trim();
      const n = digits(t).length;
      if (n < 7 || n > 15 || ISO_DATE.test(t)) return null;
      const looksLikePhone = /^[+(0]/.test(t) || /^\d{3}[-. ]\d{3}[-. ]\d{4}$/.test(t);
      return looksLikePhone ? m.replace(t, mask) : null;
    }),
  // Account numbers: a number after the word account, and any long run of digits left over.
  account: (text, mask) => {
    const a = replaceAll(text, /\b((?:account|acct|acc\.?)(?:\s+(?:no\.?|number|nr\.?|#))?\s*[:#]?\s*)(\d[\d -]{4,22}\d)\b/gi, (_m, groups) => `${groups[0]}${mask}`);
    const b = replaceAll(a.text, /\b\d{8,18}\b/g, () => mask);
    return { text: b.text, n: a.n + b.n };
  },
};

function replaceAll(text: string, re: RegExp, fn: (match: string, groups: string[]) => string | null): { text: string; n: number } {
  let n = 0;
  const out = text.replace(re, (match: string, ...rest: unknown[]) => {
    const groups = rest.slice(0, -2).map((g) => (typeof g === "string" ? g : ""));
    const r = fn(match, groups);
    if (r === null) return match;
    n++;
    return r;
  });
  return { text: out, n };
}

export interface Redacted {
  text: string;
  /** How many matches each rule masked. */
  masked: Partial<Record<RedactRule, number>>;
}

/** Masks every pattern the rules name. Rules not listed are left alone; an empty list returns the text as it was. */
export function redact(text: string, rules: readonly RedactRule[] | undefined): Redacted {
  const masked: Redacted["masked"] = {};
  if (!rules?.length || !text) return { text, masked };
  let out = text;
  for (const rule of ORDER) {
    if (!rules.includes(rule)) continue;
    const r = RULES[rule](out, REDACT_MASKS[rule]);
    out = r.text;
    if (r.n) masked[rule] = r.n;
  }
  return { text: out, masked };
}

/** A memory as it may leave the vault: title, tags and text masked with its folder's rules. */
export function redactMemory<T extends { title: string; body: string; tags?: string[]; snippet?: string }>(memory: T, rules: readonly RedactRule[] | undefined): T {
  if (!rules?.length) return memory;
  return {
    ...memory,
    title: redact(memory.title, rules).text,
    body: redact(memory.body, rules).text,
    ...(memory.tags ? { tags: memory.tags.map((t) => redact(t, rules).text) } : {}),
    ...(memory.snippet !== undefined ? { snippet: redact(memory.snippet, rules).text } : {}),
  };
}

export function isProtected(folder: FolderGuard | undefined | null): boolean {
  return !!folder?.protect;
}

/** How long an owner's yes lasts once given, and how long a request waits for one. */
export const APPROVAL_MINUTES = 10;
export const REQUEST_MINUTES = 30;

export const PROTECT_LABELS: Record<NonNullable<FolderGuard["protect"]>, string> = {
  health: "Health",
  money: "Money",
  legal: "Legal",
  other: "Private",
};
