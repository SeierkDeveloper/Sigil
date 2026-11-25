// Holder tiers. An owner links the wallet that holds the token to their vault by
// signing one message; the tier comes from that wallet's balance on chain and
// is read again every day. One wallet links to one vault at a time.
//
//   Bearer  1,000,000 or more    10 included AI answers a day, the holder mark
//   Keeper  5,000,000 or more    30 a day, the holder mark
//   Warden 10,000,000 or more    75 a day, a 3 or 4 letter handle, the day's reads anchored on chain, the Warden mark
//
// Included answers: a holder without a model key of their own asks through this
// node, which calls the model with the node's key and keeps nothing of the
// question or the answer (only a count and the token usage, for the bill). A
// holder with their own key keeps calling the model straight from their device.
// When the day's answers are used, Ask shows the memories that answer best; the
// count starts again at midnight UTC. There is no stop on the node's total: the
// spend is counted per day so the owner of the node can see it and adjust.

import { createModelCaller, hex32, fromHex32, merkleRoot, randomId, type ModelCaller, type ModelMessage } from "@sigil/core";
import { createPublicClient, createWalletClient, defineChain, formatUnits, http, isAddress, parseAbi, recoverMessageAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Db } from "./db";
import { HttpError, saveChallenge, takeChallenge } from "./store";
import { tokenConfig } from "./token";

type Row = Record<string, unknown>;

export type Tier = "bearer" | "keeper" | "warden";

/** Whole tokens a wallet must hold for each tier, highest first. */
export const TIER_MIN: [Tier, number][] = [
  ["warden", 10_000_000],
  ["keeper", 5_000_000],
  ["bearer", 1_000_000],
];

export const TIER_NAME: Record<Tier, string> = { bearer: "Bearer", keeper: "Keeper", warden: "Warden" };

/** Included AI answers a day, per tier. */
export const ANSWERS_PER_DAY: Record<Tier, number> = { bearer: 10, keeper: 30, warden: 75 };

/** Small print: an agent's writes an hour, an app's requests a minute and visitors' questions a minute to a public self or ask link. */
export const AGENT_WRITES: Record<Tier | "none", number> = { none: 300, bearer: 1000, keeper: 3000, warden: 10000 };
export const APP_REQUESTS: Record<Tier | "none", number> = { none: 240, bearer: 240, keeper: 720, warden: 1500 };
export const VISITOR_QUESTIONS: Record<Tier | "none", number> = { none: 8, bearer: 8, keeper: 30, warden: 30 };

/** How often a linked wallet's balance is read again. */
export const RECHECK_MS = 24 * 3600_000;

export function tierFor(balance: number): Tier | null {
  for (const [tier, min] of TIER_MIN) if (balance >= min) return tier;
  return null;
}

// ---------------------------------------------------------------- tables

export function trackHolders(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS holder_links (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      address TEXT NOT NULL UNIQUE,
      balance REAL NOT NULL DEFAULT 0,
      tier TEXT,
      linked_at TEXT NOT NULL,
      checked_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS holder_answers (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS answer_spend (
      day TEXT PRIMARY KEY,
      answers INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      usd REAL NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS warden_anchors (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      root TEXT NOT NULL,
      leaves INTEGER NOT NULL,
      tx TEXT,
      anchored_at TEXT,
      PRIMARY KEY (user_id, day)
    ) WITHOUT ROWID;
  `);
}

// ---------------------------------------------------------------- reading balances

export type BalanceReader = (address: Address) => Promise<number>;

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"]);

const chainBalance: BalanceReader = async (address) => {
  const c = tokenConfig();
  if (!c.token || !c.rpc) throw new HttpError(503, "The token is not set up on this node yet.", "no_token");
  const client = createPublicClient({ transport: http(c.rpc) });
  const [raw, decimals] = await Promise.all([
    client.readContract({ address: c.token, abi: ERC20, functionName: "balanceOf", args: [address] }),
    client.readContract({ address: c.token, abi: ERC20, functionName: "decimals" }).catch(() => 18),
  ]);
  return Number(formatUnits(raw, Number(decimals)));
};

// A node on one machine, for trying the tiers without a funded wallet or a paid
// model: only when SIGIL_DEV_TOOLS=on (never set on a hosted node). Balances
// come from SIGIL_HOLDER_TEST_BALANCES ({"0xaddress": tokens}), and included
// answers from SIGIL_ANSWERS_STANDIN ({"words in the question": "answer"}), where
// a memory's title in square brackets becomes its number in the prompt.
const devTools = () => process.env.SIGIL_DEV_TOOLS === "on";

const testBalance: BalanceReader = async (address) => {
  const table = JSON.parse(process.env.SIGIL_HOLDER_TEST_BALANCES || "{}") as Record<string, number>;
  const hit = Object.entries(table).find(([a]) => a.toLowerCase() === address.toLowerCase());
  return hit ? Number(hit[1]) : 0;
};

function standInCaller(): ModelCaller | null {
  const raw = process.env.SIGIL_ANSWERS_STANDIN;
  if (!raw) return null;
  const table = JSON.parse(raw) as Record<string, string>;
  return {
    provider: "anthropic",
    model: "stand-in",
    async complete(req) {
      const q = req.messages.map((m) => m.content).join(" ").toLowerCase();
      const hit = Object.entries(table).find(([words]) => q.includes(words.toLowerCase()));
      if (!hit) return "NOTHING";
      // [Title] becomes the number the prompt gave that memory.
      return hit[1].replace(/\[([^\]]+)\]/g, (whole, title: string) => {
        const m = new RegExp(`<memory n="(\\d+)" title="${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "i").exec(req.system);
        return m ? `[${m[1]}]` : whole;
      });
    },
  };
}

let readBalance: BalanceReader = devTools() && process.env.SIGIL_HOLDER_TEST_BALANCES ? testBalance : chainBalance;

/** Tests read balances from a table instead of a chain. */
export function setBalanceReader(fn: BalanceReader | null): void {
  readBalance = fn ?? chainBalance;
}

// ---------------------------------------------------------------- linking a wallet

const today = (at = new Date()) => at.toISOString().slice(0, 10);

export function linkMessage(address: string, nonce: string): string {
  return [
    "Sigil: link this wallet to my vault as a holder.",
    "",
    `Wallet: ${address.toLowerCase()}`,
    `Nonce: ${nonce}`,
    "",
    "This only proves the wallet is mine. It sends nothing and costs nothing.",
  ].join("\n");
}

export function holderChallenge(db: Db, userId: string, address: string): { challengeId: string; message: string } {
  if (!isAddress(address)) throw new HttpError(400, "That is not a wallet address.", "bad_address");
  const nonce = randomId();
  const message = linkMessage(address, nonce);
  return { challengeId: saveChallenge(db, `${address.toLowerCase()}|${message}`, "holder", userId), message };
}

export async function linkHolder(db: Db, userId: string, input: { challengeId: string; address: string; signature: string }, at = new Date()): Promise<HolderStatus> {
  const c = takeChallenge(db, input.challengeId, "holder");
  const [addr, ...rest] = c.challenge.split("|");
  const message = rest.join("|");
  if (c.userId !== userId || addr !== input.address.toLowerCase()) throw new HttpError(400, "That signature was for another request. Please try again.", "challenge");
  let signer: string;
  try {
    signer = await recoverMessageAddress({ message, signature: input.signature as Hex });
  } catch {
    throw new HttpError(400, "That signature could not be read. Please sign again.", "bad_signature");
  }
  if (signer.toLowerCase() !== addr) throw new HttpError(400, "The signature is not from that wallet.", "bad_signature");
  const other = db.prepare("SELECT user_id FROM holder_links WHERE address = ?").get(addr) as Row | undefined;
  if (other && String(other.user_id) !== userId) throw new HttpError(409, "That wallet is already linked to another vault. Unlink it there first.", "wallet_taken");
  const balance = await readBalance(addr as Address);
  const iso = at.toISOString();
  db.prepare(
    `INSERT INTO holder_links (user_id, address, balance, tier, linked_at, checked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET address = excluded.address, balance = excluded.balance, tier = excluded.tier, linked_at = excluded.linked_at, checked_at = excluded.checked_at`,
  ).run(userId, addr, balance, tierFor(balance), iso, iso);
  return holderStatus(db, userId, at);
}

export function unlinkHolder(db: Db, userId: string): void {
  db.prepare("DELETE FROM holder_links WHERE user_id = ?").run(userId);
}

/** Reads one vault's balance again now. */
export async function refreshHolder(db: Db, userId: string, at = new Date()): Promise<HolderStatus> {
  const r = db.prepare("SELECT address FROM holder_links WHERE user_id = ?").get(userId) as Row | undefined;
  if (r) {
    const balance = await readBalance(String(r.address) as Address);
    db.prepare("UPDATE holder_links SET balance = ?, tier = ?, checked_at = ? WHERE user_id = ?").run(balance, tierFor(balance), at.toISOString(), userId);
  }
  return holderStatus(db, userId, at);
}

/** Called on the server's timer: wallets read more than a day ago are read again, a few at a time. */
export async function holderTick(db: Db, at = new Date()): Promise<number> {
  const due = db.prepare("SELECT user_id, address FROM holder_links WHERE checked_at < ? ORDER BY checked_at LIMIT 25").all(new Date(at.getTime() - RECHECK_MS).toISOString()) as Row[];
  let n = 0;
  for (const r of due) {
    try {
      const balance = await readBalance(String(r.address) as Address);
      db.prepare("UPDATE holder_links SET balance = ?, tier = ?, checked_at = ? WHERE user_id = ?").run(balance, tierFor(balance), at.toISOString(), String(r.user_id));
      n++;
    } catch {
      // The chain did not answer; this wallet is tried again on the next tick.
    }
  }
  return n;
}

// ---------------------------------------------------------------- status

export interface HolderStatus {
  linked: boolean;
  address: string | null;
  balance: number;
  tier: Tier | null;
  answersPerDay: number;
  answersUsedToday: number;
  /** Whether this node offers included answers at all (it has a model key for them). */
  includedOn: boolean;
  checkedAt: string | null;
  anchors: { day: string; root: string; leaves: number; tx: string | null }[];
}

export function tierOf(db: Db, userId: string): Tier | null {
  const r = db.prepare("SELECT tier FROM holder_links WHERE user_id = ?").get(userId) as Row | undefined;
  const t = r?.tier ? String(r.tier) : null;
  return t === "bearer" || t === "keeper" || t === "warden" ? t : null;
}

export function holderStatus(db: Db, userId: string, at = new Date()): HolderStatus {
  const r = db.prepare("SELECT * FROM holder_links WHERE user_id = ?").get(userId) as Row | undefined;
  const tier = tierOf(db, userId);
  const used = db.prepare("SELECT used FROM holder_answers WHERE user_id = ? AND day = ?").get(userId, today(at)) as Row | undefined;
  const anchors = tier === "warden"
    ? (db.prepare("SELECT day, root, leaves, tx FROM warden_anchors WHERE user_id = ? ORDER BY day DESC LIMIT 14").all(userId) as Row[]).map((a) => ({ day: String(a.day), root: String(a.root), leaves: Number(a.leaves), tx: a.tx ? String(a.tx) : null }))
    : [];
  return {
    linked: !!r,
    address: r ? String(r.address) : null,
    balance: r ? Number(r.balance) : 0,
    tier,
    answersPerDay: tier ? ANSWERS_PER_DAY[tier] : 0,
    answersUsedToday: Number(used?.used ?? 0),
    includedOn: !!answerSettings().apiKey || (devTools() && !!process.env.SIGIL_ANSWERS_STANDIN),
    checkedAt: r ? String(r.checked_at) : null,
    anchors,
  };
}

/** What a public page shows: the tier only, never the wallet or the balance. */
export function publicTier(db: Db, userId: string): Tier | null {
  return tierOf(db, userId);
}

// ---------------------------------------------------------------- included answers

function answerSettings(env: Record<string, string | undefined> = process.env) {
  return {
    apiKey: (env.SIGIL_ANSWERS_KEY || "").trim(),
    model: (env.SIGIL_ANSWERS_MODEL || "claude-haiku-5-5").trim(),
    usdPerMInput: Number(env.SIGIL_ANSWERS_USD_IN || 1),
    usdPerMOutput: Number(env.SIGIL_ANSWERS_USD_OUT || 5),
  };
}

let answerModel: (() => ModelCaller | null) | null = null;

/** Tests answer with a stand-in. */
export function setAnswerModel(fn: (() => ModelCaller | null) | null): void {
  answerModel = fn;
}

function includedCaller(): ModelCaller | null {
  if (answerModel) return answerModel();
  if (devTools() && process.env.SIGIL_ANSWERS_STANDIN) return standInCaller();
  const s = answerSettings();
  return s.apiKey ? createModelCaller({ provider: "anthropic", model: s.model, apiKey: s.apiKey }) : null;
}

/**
 * One included answer for a holder. The question and the memories pass through
 * this call to the model and are not written anywhere; only the day's count and
 * an estimate of the tokens are kept.
 */
export async function includedAnswer(db: Db, userId: string, req: { system: string; messages: ModelMessage[]; maxTokens?: number }, at = new Date()): Promise<{ text: string; left: number }> {
  const tier = tierOf(db, userId);
  if (!tier) throw new HttpError(403, "Included answers come with holding 1,000,000 tokens or more. Link your wallet under Holder.", "not_holder");
  const caller = includedCaller();
  if (!caller) throw new HttpError(503, "This node does not offer included answers right now. Your own model key still works.", "included_off");
  const day = today(at);
  const perDay = ANSWERS_PER_DAY[tier];
  const used = Number((db.prepare("SELECT used FROM holder_answers WHERE user_id = ? AND day = ?").get(userId, day) as Row | undefined)?.used ?? 0);
  if (used >= perDay) throw new HttpError(429, `Today's ${perDay} included answers are used. They come back at midnight UTC.`, "answers_used");
  // Counted before the call, so two at once cannot both take the last one.
  db.prepare("INSERT INTO holder_answers (user_id, day, used) VALUES (?, ?, 1) ON CONFLICT (user_id, day) DO UPDATE SET used = used + 1").run(userId, day);
  let text: string;
  try {
    text = await caller.complete({ ...req, maxTokens: Math.min(req.maxTokens ?? 1500, 2000) });
  } catch (err) {
    db.prepare("UPDATE holder_answers SET used = MAX(used - 1, 0) WHERE user_id = ? AND day = ?").run(userId, day);
    throw err;
  }
  const s = answerSettings();
  const input = Math.ceil((req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0)) / 4);
  const output = Math.ceil(text.length / 4);
  const usd = (input * s.usdPerMInput + output * s.usdPerMOutput) / 1_000_000;
  db.prepare(
    `INSERT INTO answer_spend (day, answers, input_tokens, output_tokens, usd) VALUES (?, 1, ?, ?, ?)
     ON CONFLICT (day) DO UPDATE SET answers = answers + 1, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens, usd = usd + excluded.usd`,
  ).run(day, input, output, usd);
  return { text, left: perDay - used - 1 };
}

/** The node's included-answer spend per day, newest first, and this month's total. */
export function answerSpend(db: Db, at = new Date()): { month: string; usd: number; answers: number; days: { day: string; answers: number; usd: number }[] } {
  const month = at.toISOString().slice(0, 7);
  const days = (db.prepare("SELECT day, answers, usd FROM answer_spend ORDER BY day DESC LIMIT 62").all() as Row[]).map((r) => ({ day: String(r.day), answers: Number(r.answers), usd: Number(r.usd) }));
  const inMonth = days.filter((d) => d.day.startsWith(month));
  return { month, usd: inMonth.reduce((n, d) => n + d.usd, 0), answers: inMonth.reduce((n, d) => n + d.answers, 0), days };
}

// ---------------------------------------------------------------- Warden: the day's reads on chain

export type AnchorSender = (data: Hex) => Promise<string>;

function anchorSender(env: Record<string, string | undefined> = process.env): AnchorSender | null {
  const key = (env.SIGIL_WARDEN_ANCHOR_KEY || "").trim();
  const rpc = (env.SIGIL_WARDEN_ANCHOR_RPC || tokenConfig(env).rpc || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key) || !rpc) return null;
  return async (data) => {
    const transport = http(rpc);
    const chainId = await createPublicClient({ transport }).getChainId();
    const chain = defineChain({ id: chainId, name: "anchor", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    const account = privateKeyToAccount(key as Hex);
    const wallet = createWalletClient({ account, chain, transport });
    // A transaction to itself carrying the roots: no contract, the cheapest kind there is.
    return wallet.sendTransaction({ to: account.address, value: 0n, data });
  };
}

let sendAnchor: AnchorSender | null | undefined;

export function setAnchorSender(fn: AnchorSender | null | undefined): void {
  sendAnchor = fn;
}

/**
 * Once a day: for every Warden, the root over yesterday's read-log leaves of
 * their vault (the same leaves the hourly seals hold), all roots in one
 * transaction. Returns the transaction, or null when there was nothing to send
 * or no sender is set up.
 */
export async function wardenAnchorTick(db: Db, at = new Date()): Promise<string | null> {
  const yesterday = today(new Date(at.getTime() - 86_400_000));
  const wardens = (db.prepare("SELECT user_id FROM holder_links WHERE tier = 'warden'").all() as Row[]).map((r) => String(r.user_id));
  const fresh: { userId: string; root: string; leaves: number }[] = [];
  for (const userId of wardens) {
    if (db.prepare("SELECT 1 FROM warden_anchors WHERE user_id = ? AND day = ?").get(userId, yesterday)) continue;
    const leaves = (db.prepare("SELECT leaf FROM read_log WHERE user_id = ? AND substr(at, 1, 10) = ? ORDER BY at, id").all(userId, yesterday) as Row[]).map((r) => fromHex32(String(r.leaf)));
    if (!leaves.length) continue;
    const root = hex32(merkleRoot(leaves));
    db.prepare("INSERT INTO warden_anchors (user_id, day, root, leaves) VALUES (?, ?, ?, ?)").run(userId, yesterday, root, leaves.length);
    fresh.push({ userId, root, leaves: leaves.length });
  }
  const pending = db.prepare("SELECT user_id, root FROM warden_anchors WHERE tx IS NULL ORDER BY day, user_id LIMIT 200").all() as Row[];
  const sender = sendAnchor === undefined ? anchorSender() : sendAnchor;
  if (!pending.length || !sender) return null;
  const data = ("0x" + Buffer.from("sigil-warden-v1:").toString("hex") + pending.map((p) => String(p.root).replace(/^0x/, "")).join("")) as Hex;
  const tx = await sender(data);
  const mark = db.prepare("UPDATE warden_anchors SET tx = ?, anchored_at = ? WHERE user_id = ? AND root = ?");
  for (const p of pending) mark.run(tx, at.toISOString(), String(p.user_id), String(p.root));
  return tx;
}
