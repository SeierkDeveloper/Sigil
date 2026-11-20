// The AI self's on-chain identity and its own wallet, the parts that work on
// the device and need no chain at all.
//
//   self key   a secp256k1 key derived from the vault key on the device:
//              seed = HKDF(vault key, "sigil:self:identity:v1"), the first
//              value that is a valid key (the counter is appended from 1 on
//              in the very rare case it is not). Its EVM address is the self's
//              identity on chain. It is never stored and never sent.
//   statement  a signed identity statement: the self key, the vault's signing
//              key (Ed25519, see life.ts) and what the owner says about the
//              self, signed by both keys, so each vouches for the other.
//   rules      the owner's rules for the self wallet (contracts/src/
//              SigilSelfWallet.sol): caps per transaction and per day,
//              recipients, contracts and the functions it may call on them,
//              token caps and an expiry. Drafted and kept encrypted in the
//              vault; `walletConfig` gives the exact arguments of configure().
//
// EIP-712 digests for SigilSelfRegistry.register and SigilSelfWallet.execute
// are computed here byte for byte as the contracts compute them, so the self
// key can sign on the device and anyone can submit the signature.

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "./crypto";
import { concatBytes, fromBase64Url, fromHex, toBase64Url, toHex, utf8 } from "./encoding";
import { canonicalJson, isSigningKey, signingFingerprint, type CertificateCheck, type SigningKey } from "./life";

export const IDENTITY_FORMAT = "sigil-self-identity";
export const WALLET_RULES_FORMAT = "sigil-wallet-rules";

// ---------------------------------------------------------------- addresses and hashes

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS.test(value);
}

/** The EIP-55 mixed-case form of an address. */
export function checksumAddress(address: string): string {
  if (!isEvmAddress(address)) throw new Error("That is not an address (0x and 40 hex characters).");
  const lower = address.slice(2).toLowerCase();
  const hash = toHex(keccak_256(utf8(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function keccakHex(data: string | Uint8Array): string {
  return "0x" + toHex(keccak_256(typeof data === "string" ? utf8(data) : data));
}

function addressFromPublicKey(uncompressed: Uint8Array): string {
  return checksumAddress("0x" + toHex(keccak_256(uncompressed.slice(1)).slice(12)));
}

// ---------------------------------------------------------------- the self key

export interface SelfKey {
  secret: Uint8Array;
  /** The EVM address of the self key, EIP-55. */
  address: string;
}

/** The self key, derived from the vault key on the device. The same vault always gives the same key. */
export async function selfIdentityKey(vaultKey: Uint8Array): Promise<SelfKey> {
  for (let i = 0; i < 16; i++) {
    const secret = await hkdf(vaultKey, i === 0 ? "sigil:self:identity:v1" : `sigil:self:identity:v1:${i}`);
    if (secp256k1.utils.isValidSecretKey(secret)) return { secret, address: addressFromPublicKey(secp256k1.getPublicKey(secret, false)) };
  }
  throw new Error("No valid self key could be derived.");
}

/** A 65-byte signature over a 32-byte digest, as r || s || v with v 27 or 28 and a low s, the way the contracts and wallets expect it. */
export function signDigest(secret: Uint8Array, digest: Uint8Array): string {
  if (digest.length !== 32) throw new Error("A digest is 32 bytes.");
  const rec = secp256k1.sign(digest, secret, { prehash: false, format: "recovered" });
  return "0x" + toHex(concatBytes(rec.slice(1), new Uint8Array([27 + rec[0]])));
}

/** The address that made a signature over a digest, or null when it is not a valid signature. */
export function recoverDigest(digest: Uint8Array, signature: string): string | null {
  try {
    const sig = fromHex(signature);
    if (sig.length !== 65) return null;
    const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
    if (v !== 0 && v !== 1) return null;
    const pub = secp256k1.recoverPublicKey(concatBytes(new Uint8Array([v]), sig.slice(0, 64)), digest, { prehash: false });
    return addressFromPublicKey(secp256k1.Point.fromBytes(pub).toBytes(false));
  } catch {
    return null;
  }
}

/** EIP-191 personal message hash, as wallets sign text. */
export function personalMessageHash(message: string): Uint8Array {
  const bytes = utf8(message);
  return keccak_256(concatBytes(utf8(`\x19Ethereum Signed Message:\n${bytes.length}`), bytes));
}

// ---------------------------------------------------------------- EIP-712, as the contracts compute it

const word = (n: bigint) => {
  if (n < 0n || n >= 1n << 256n) throw new Error("Out of range for uint256.");
  return fromHex(n.toString(16).padStart(64, "0"));
};
const addrWord = (a: string) => {
  if (!isEvmAddress(a)) throw new Error("That is not an address.");
  return concatBytes(new Uint8Array(12), fromHex(a));
};
const k = (s: string | Uint8Array) => keccak_256(typeof s === "string" ? utf8(s) : s);

const DOMAIN_TYPE = k("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
const REGISTER_TYPE = k("Register(address owner,address selfKey,string metadataURI,uint256 deadline)");
const EXECUTE_TYPE = k("Execute(address target,uint256 value,bytes data,uint256 nonce,uint256 deadline)");

export function domainSeparator(name: string, chainId: bigint, contract: string): Uint8Array {
  return k(concatBytes(DOMAIN_TYPE, k(name), k("1"), word(chainId), addrWord(contract)));
}

function typedDigest(domain: Uint8Array, structHash: Uint8Array): Uint8Array {
  return k(concatBytes(new Uint8Array([0x19, 0x01]), domain, structHash));
}

export interface RegisterInput {
  chainId: bigint;
  registry: string;
  owner: string;
  selfKey: string;
  metadataURI: string;
  /** Unix seconds. */
  deadline: bigint;
}

/** What the self key signs so its owner can register it (SigilSelfRegistry.registerDigest). */
export function registerDigest(i: RegisterInput): Uint8Array {
  const struct = k(concatBytes(REGISTER_TYPE, addrWord(i.owner), addrWord(i.selfKey), k(i.metadataURI), word(i.deadline)));
  return typedDigest(domainSeparator("SigilSelfRegistry", i.chainId, i.registry), struct);
}

export interface ExecuteInput {
  chainId: bigint;
  wallet: string;
  target: string;
  value: bigint;
  /** Call data as 0x hex, "0x" for none. */
  data: string;
  nonce: bigint;
  deadline: bigint;
}

/** What the self key signs for a call anyone may submit (SigilSelfWallet.executeDigest). */
export function executeDigest(i: ExecuteInput): Uint8Array {
  const struct = k(concatBytes(EXECUTE_TYPE, addrWord(i.target), word(i.value), k(fromHex(i.data)), word(i.nonce), word(i.deadline)));
  return typedDigest(domainSeparator("SigilSelfWallet", i.chainId, i.wallet), struct);
}

// ---------------------------------------------------------------- amounts

/** "1.5" in units of 10^decimals, as wei for 18. Refuses anything that is not a plain positive decimal. */
export function parseUnits(text: string, decimals = 18): bigint {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`"${text}" is not an amount.`);
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) throw new Error(`"${text}" has more than ${decimals} decimals.`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function formatUnits(value: bigint, decimals = 18): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${v / base}${frac ? `.${frac}` : ""}`;
}

// ---------------------------------------------------------------- function selectors

const SIGNATURE = /^[A-Za-z_][A-Za-z0-9_]*\(([A-Za-z0-9_[\],() ]*)\)$/;

/** The four-byte selector of a function signature such as "transfer(address,uint256)". */
export function functionSelector(signature: string): string {
  const s = signature.replace(/\s+/g, "");
  if (!SIGNATURE.test(s)) throw new Error(`"${signature}" is not a function signature like transfer(address,uint256).`);
  return "0x" + toHex(keccak_256(utf8(s)).slice(0, 4));
}

export const TOKEN_SELECTORS = {
  transfer: functionSelector("transfer(address,uint256)"),
  approve: functionSelector("approve(address,uint256)"),
} as const;

/** Selectors the wallet refuses to the self key even when allowed: they move tokens without a cap it can check. */
export const REFUSED_SELECTORS = [
  functionSelector("transferFrom(address,address,uint256)"),
  functionSelector("increaseAllowance(address,uint256)"),
  functionSelector("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)"),
];

// ---------------------------------------------------------------- wallet rules

export interface RulesRecipient {
  address: string;
  label: string;
}

export interface RulesContract {
  address: string;
  label: string;
  /** Function signatures the self may call on it. */
  functions: string[];
}

export interface RulesToken {
  address: string;
  label: string;
  decimals: number;
  /** Amounts in whole tokens, as decimals. */
  perTx: string;
  perDay: string;
}

export interface WalletRules {
  /** Native value, in whole units (ether on Ethereum), as decimals. */
  perTx: string;
  perDay: string;
  /** After this time the self can do nothing; null for no end. */
  expiresAt: string | null;
  recipients: RulesRecipient[];
  contracts: RulesContract[];
  tokens: RulesToken[];
}

export const EMPTY_RULES: WalletRules = { perTx: "0", perDay: "0", expiresAt: null, recipients: [], contracts: [], tokens: [] };

const label = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 80);

function amount(v: unknown, decimals = 18): string {
  const t = String(v ?? "0").trim() || "0";
  return formatUnits(parseUnits(t, decimals), decimals);
}

/** Checks and normalises rules typed by the owner. Throws with a plain reason for anything the wallet would not take. */
export function cleanWalletRules(value: unknown): WalletRules {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const list = (x: unknown) => (Array.isArray(x) ? x : []) as Record<string, unknown>[];
  const seen = new Set<string>();
  const addr = (a: unknown, what: string) => {
    const s = String(a ?? "").trim();
    if (!isEvmAddress(s)) throw new Error(`The ${what} "${s}" is not an address.`);
    if (/^0x0{40}$/.test(s)) throw new Error(`The ${what} cannot be the zero address.`);
    const c = checksumAddress(s);
    if (seen.has(c.toLowerCase())) throw new Error(`${c} is listed twice.`);
    seen.add(c.toLowerCase());
    return c;
  };
  const expires = v.expiresAt ? new Date(String(v.expiresAt)) : null;
  if (expires && !Number.isFinite(expires.getTime())) throw new Error("The end date is not a date.");
  const rules: WalletRules = {
    perTx: amount(v.perTx),
    perDay: amount(v.perDay),
    expiresAt: expires ? new Date(Math.floor(expires.getTime() / 1000) * 1000).toISOString() : null,
    recipients: list(v.recipients).slice(0, 50).map((r) => ({ address: addr(r.address, "recipient"), label: label(r.label) })),
    contracts: list(v.contracts)
      .slice(0, 50)
      .map((c) => ({
        address: addr(c.address, "contract"),
        label: label(c.label),
        functions: [...new Set(list(c.functions).map((f) => String(f).replace(/\s+/g, "")))].slice(0, 20).map((f) => {
          functionSelector(f);
          return f;
        }),
      })),
    tokens: list(v.tokens)
      .slice(0, 20)
      .map((t) => {
        const decimals = Number(t.decimals ?? 18);
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Token decimals are a whole number from 0 to 36.");
        return { address: addr(t.address, "token"), label: label(t.label), decimals, perTx: amount(t.perTx, decimals), perDay: amount(t.perDay, decimals) };
      }),
  };
  if (parseUnits(rules.perTx) > parseUnits(rules.perDay)) throw new Error("The cap per transaction is above the cap per day.");
  for (const t of rules.tokens) if (parseUnits(t.perTx, t.decimals) > parseUnits(t.perDay, t.decimals)) throw new Error(`${t.label || t.address}: the cap per transaction is above the cap per day.`);
  return rules;
}

/** A fingerprint of a rules draft: SHA-256 over the format line and the canonical JSON. */
export function walletRulesHash(rules: WalletRules): string {
  return "0x" + toHex(sha256(utf8(`${WALLET_RULES_FORMAT}-v1\n${canonicalJson(cleanWalletRules(rules))}`)));
}

export interface WalletConfig {
  perTxCap: bigint;
  perDayCap: bigint;
  expiresAt: bigint;
  targets: string[];
  selectors: { target: string; selector: string }[];
  tokens: { token: string; perTx: bigint; perDay: bigint }[];
}

/** The exact arguments of SigilSelfWallet.configure for these rules. Tokens are targets too, and each gets transfer and approve. */
export function walletConfig(input: WalletRules): WalletConfig {
  const rules = cleanWalletRules(input);
  const targets = [...rules.recipients.map((r) => r.address), ...rules.contracts.map((c) => c.address), ...rules.tokens.map((t) => t.address)];
  const selectors = [
    ...rules.contracts.flatMap((c) => c.functions.map((f) => ({ target: c.address, selector: functionSelector(f) }))),
    ...rules.tokens.flatMap((t) => [TOKEN_SELECTORS.transfer, TOKEN_SELECTORS.approve].map((selector) => ({ target: t.address, selector }))),
  ];
  return {
    perTxCap: parseUnits(rules.perTx),
    perDayCap: parseUnits(rules.perDay),
    expiresAt: rules.expiresAt ? BigInt(Math.floor(Date.parse(rules.expiresAt) / 1000)) : 0n,
    targets,
    selectors,
    tokens: rules.tokens.map((t) => ({ token: t.address, perTx: parseUnits(t.perTx, t.decimals), perDay: parseUnits(t.perDay, t.decimals) })),
  };
}

export interface CallToCheck {
  target: string;
  /** Native value in whole units, as decimals. */
  value: string;
  /** The function signature, or "" for a plain payment. */
  fn: string;
  /** For transfer and approve: the recipient or spender, and the amount in whole tokens. */
  to?: string;
  amount?: string;
}

export interface Spent {
  native: bigint;
  /** By token address, lower case. */
  tokens: Record<string, bigint>;
}

/**
 * What the wallet would say to a call by the self key under these rules, the
 * same checks in the same order as the contract. For the vault to show the
 * owner what a draft allows before it is set on chain.
 */
export function checkCall(input: WalletRules, call: CallToCheck, spent: Spent = { native: 0n, tokens: {} }, opts: { frozen?: boolean; now?: number } = {}): { ok: true } | { ok: false; reason: string } {
  const rules = cleanWalletRules(input);
  const no = (reason: string) => ({ ok: false as const, reason });
  if (opts.frozen) return no("The wallet is frozen.");
  if (rules.expiresAt && (opts.now ?? Date.now()) >= Date.parse(rules.expiresAt)) return no("The rules have expired.");
  if (!isEvmAddress(call.target)) return no("The target is not an address.");
  const config = walletConfig(rules);
  if (!config.targets.some((t) => sameAddress(t, call.target))) return no("The target is not on the allowed list.");
  if (call.fn.trim()) {
    let selector: string;
    try {
      selector = functionSelector(call.fn);
    } catch (err) {
      return no((err as Error).message);
    }
    if (!config.selectors.some((s) => sameAddress(s.target, call.target) && s.selector === selector)) return no("That function is not allowed on this contract.");
    if (selector === TOKEN_SELECTORS.transfer || selector === TOKEN_SELECTORS.approve) {
      const token = rules.tokens.find((t) => sameAddress(t.address, call.target));
      if (!token) return no("This token has no caps, so it cannot be moved.");
      if (!call.to || !config.targets.some((t) => sameAddress(t, call.to))) return no("The recipient is not on the allowed list.");
      const amt = parseUnits(call.amount ?? "0", token.decimals);
      if (amt > parseUnits(token.perTx, token.decimals)) return no("Over the token's cap per transaction.");
      if ((spent.tokens[token.address.toLowerCase()] ?? 0n) + amt > parseUnits(token.perDay, token.decimals)) return no("Over the token's cap per day.");
    } else if (REFUSED_SELECTORS.includes(selector)) {
      return no("The wallet never lets the self call this function.");
    }
  }
  const value = parseUnits(call.value || "0");
  if (value > 0n) {
    if (value > config.perTxCap) return no("Over the cap per transaction.");
    if (spent.native + value > config.perDayCap) return no("Over the cap per day.");
  }
  return { ok: true };
}

// ---------------------------------------------------------------- spends, from the wallet's events

/** topic0 of SigilSelfWallet.Executed. */
export const EXECUTED_TOPIC = keccakHex("Executed(uint256,address,uint256,bytes4,address,uint256)");

export interface WalletSpend {
  nonce: number;
  target: string;
  value: bigint;
  selector: string | null;
  tokenTo: string | null;
  tokenAmount: bigint;
  block: number;
  tx: string;
}

/** Reads one Executed log as returned by eth_getLogs. Null for anything else. */
export function decodeSpendLog(log: { topics: string[]; data: string; blockNumber?: string; transactionHash?: string }): WalletSpend | null {
  if (!log.topics || log.topics[0]?.toLowerCase() !== EXECUTED_TOPIC || log.topics.length < 3) return null;
  const data = (log.data ?? "").replace(/^0x/, "");
  if (data.length !== 256) return null;
  const part = (i: number) => data.slice(i * 64, (i + 1) * 64);
  const selector = "0x" + part(1).slice(0, 8);
  const tokenTo = "0x" + part(2).slice(24);
  return {
    nonce: Number(BigInt(log.topics[1])),
    target: checksumAddress("0x" + log.topics[2].slice(-40)),
    value: BigInt("0x" + part(0)),
    selector: selector === "0x00000000" ? null : selector,
    tokenTo: /^0x0{40}$/.test(tokenTo) ? null : checksumAddress(tokenTo),
    tokenAmount: BigInt("0x" + part(3)),
    block: log.blockNumber ? Number(BigInt(log.blockNumber)) : 0,
    tx: log.transactionHash ?? "",
  };
}

// ---------------------------------------------------------------- the identity statement

export interface IdentityChain {
  chainId: string;
  registry: string;
}

export interface IdentityBody {
  /** The self key's address. */
  selfKey: string;
  /** The vault's Ed25519 signing key, the same that signs presence and certificates. */
  signingKey: string;
  /** The name the AI self goes by. */
  name: string;
  /** What the owner says the self is for, in a line or two. */
  about: string;
  /** The owner's own EVM address that registers the self, when chosen. */
  owner: string | null;
  /** The self wallet, when there is one. */
  wallet: string | null;
  /** The registry the self is (or will be) registered in. */
  chain: IdentityChain | null;
  /** The site the vault lives on. */
  origin: string;
  issuedAt: string;
}

export interface IdentityStatement {
  format: typeof IDENTITY_FORMAT;
  version: 1;
  body: IdentityBody;
  /** Ed25519 by the vault's signing key, base64url. */
  vaultSignature: string;
  /** EIP-191 by the self key, 0x hex, the way wallets sign text. */
  selfSignature: string;
}

export function identityMessage(body: IdentityBody): string {
  return `${IDENTITY_FORMAT}-v1\n${canonicalJson(body)}`;
}

export function cleanIdentityBody(value: Partial<IdentityBody>): IdentityBody {
  const opt = (a: unknown) => (a ? checksumAddress(String(a)) : null);
  const chain = value.chain && value.chain.registry ? { chainId: String(BigInt(value.chain.chainId)), registry: checksumAddress(value.chain.registry) } : null;
  return {
    selfKey: checksumAddress(String(value.selfKey ?? "")),
    signingKey: String(value.signingKey ?? ""),
    name: label(value.name) || "My AI self",
    about: String(value.about ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
    owner: opt(value.owner),
    wallet: opt(value.wallet),
    chain,
    origin: String(value.origin ?? "").replace(/\/$/, ""),
    issuedAt: value.issuedAt ?? new Date().toISOString(),
  };
}

/** Signs a statement with both keys. The self key must be the one the body names. */
export function signIdentity(signing: SigningKey, self: SelfKey, input: Omit<IdentityBody, "selfKey" | "signingKey"> & Partial<Pick<IdentityBody, "selfKey" | "signingKey">>): IdentityStatement {
  const body = cleanIdentityBody({ ...input, selfKey: self.address, signingKey: signing.publicKey });
  const message = identityMessage(body);
  return {
    format: IDENTITY_FORMAT,
    version: 1,
    body,
    vaultSignature: toBase64Url(ed25519.sign(utf8(message), signing.seed)),
    selfSignature: signDigest(self.secret, personalMessageHash(message)),
  };
}

export function parseIdentityStatement(text: string): IdentityStatement {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("This is not an identity statement: it is not valid JSON.");
  }
  const s = v as IdentityStatement;
  if (!s || s.format !== IDENTITY_FORMAT || s.version !== 1 || !s.body || typeof s.vaultSignature !== "string" || typeof s.selfSignature !== "string") {
    throw new Error("This is not a Sigil identity statement.");
  }
  return s;
}

export interface IdentityResult {
  ok: boolean;
  checks: CertificateCheck[];
}

/** Checks a statement on this device: both signatures over the same body, each by the key the body names. */
export function verifyIdentityStatement(s: IdentityStatement): IdentityResult {
  const checks: CertificateCheck[] = [];
  const b = s.body;
  let message = "";
  try {
    message = identityMessage(b);
  } catch {
    message = "";
  }
  let vaultOk = false;
  try {
    vaultOk = !!message && isSigningKey(b.signingKey) && ed25519.verify(fromBase64Url(s.vaultSignature), utf8(message), fromBase64Url(b.signingKey));
  } catch {
    vaultOk = false;
  }
  checks.push({
    name: "vault",
    ok: vaultOk,
    detail: vaultOk ? `Signed by the vault's signing key ${signingFingerprint(b.signingKey)}.` : "The vault's signature does not match this statement, or it was changed after signing.",
  });
  const signer = message ? recoverDigest(personalMessageHash(message), s.selfSignature) : null;
  const selfOk = !!signer && sameAddress(signer, b.selfKey);
  checks.push({ name: "self", ok: selfOk, detail: selfOk ? `Signed by the self key ${b.selfKey}.` : "The self key's signature does not match this statement." });
  return { ok: vaultOk && selfOk, checks };
}
