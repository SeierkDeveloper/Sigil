// The AI self's identity on the owner's device: the self key (derived from the
// vault key, never stored), the identity statement signed by the vault key and
// the self key, the rules of its wallet (encrypted like every setting), and,
// once the site has a registry on chain, the calls the owner's own wallet sends
// and the wallet's state and spends read through a public read-only address.
// Nothing here holds or sends a private key.

import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import {
  checksumAddress,
  cleanWalletRules,
  decodeSpendLog,
  EXECUTED_TOPIC,
  isEvmAddress,
  openSetting,
  parseIdentityStatement,
  registerDigest,
  sealSetting,
  selfIdentityKey,
  signDigest,
  signIdentity,
  vaultSigningKey,
  walletConfig,
  type IdentityStatement,
  type WalletRules,
  type WalletSpend,
} from "@sigil/core";
import type { Api } from "./api";
import type { Unlocked } from "./ops";

export interface ChainConfig {
  chainId: string;
  registry: string;
  rpcUrl: string;
}

export interface IdentityChoices {
  name: string;
  about: string;
  /** The owner's own address that registers the self and owns its wallet. */
  owner: string;
  /** The self wallet, once deployed. */
  wallet: string;
}

export const EMPTY_CHOICES: IdentityChoices = { name: "", about: "", owner: "", wallet: "" };

export interface ServerIdentity {
  address: string;
  statement: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IdentityView {
  address: string;
  statement: IdentityStatement | null;
  createdAt: string;
  updatedAt: string;
}

export function openIdentity(row: ServerIdentity | null | undefined): IdentityView | null {
  if (!row) return null;
  let statement: IdentityStatement | null = null;
  try {
    statement = row.statement ? parseIdentityStatement(row.statement) : null;
  } catch {
    statement = null;
  }
  return { address: row.address, statement, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export async function openChoices(vault: Unlocked, envelope: string | undefined): Promise<IdentityChoices> {
  if (!envelope) return EMPTY_CHOICES;
  const v = await openSetting<Partial<IdentityChoices>>(vault.key, "identity", envelope);
  return { name: String(v.name ?? ""), about: String(v.about ?? ""), owner: String(v.owner ?? ""), wallet: String(v.wallet ?? "") };
}

export async function openRules(vault: Unlocked, envelope: string | undefined): Promise<WalletRules | null> {
  if (!envelope) return null;
  return cleanWalletRules(await openSetting<unknown>(vault.key, "wallet", envelope));
}

// ---------------------------------------------------------------- off chain

/** Derives the self key on this device and records its address. */
export async function makeSelfKey(api: Api, vault: Unlocked): Promise<IdentityView> {
  const key = await selfIdentityKey(vault.raw);
  const r = await api.post<{ identity: ServerIdentity }>("self/identity", { address: key.address });
  return openIdentity(r.identity)!;
}

export async function saveChoices(api: Api, vault: Unlocked, choices: IdentityChoices): Promise<IdentityChoices> {
  const clean = { name: choices.name.trim().slice(0, 80), about: choices.about.trim().slice(0, 400), owner: choices.owner.trim(), wallet: choices.wallet.trim() };
  await api.put("settings/identity", { value: await sealSetting(vault.key, "identity", clean) });
  return clean;
}

export function metadataUrl(origin: string, address: string): string {
  return `${origin.replace(/\/$/, "")}/api/identity/at/${address}`;
}

/** Signs a new identity statement with both keys, on this device, and publishes it at the self key's metadata address. */
export async function signStatement(api: Api, vault: Unlocked, choices: IdentityChoices, chain: ChainConfig | null, origin: string): Promise<IdentityView> {
  const statement = signIdentity(await vaultSigningKey(vault.raw), await selfIdentityKey(vault.raw), {
    name: choices.name,
    about: choices.about,
    owner: choices.owner || null,
    wallet: choices.wallet || null,
    chain: chain ? { chainId: chain.chainId, registry: chain.registry } : null,
    origin,
    issuedAt: new Date().toISOString(),
  });
  const r = await api.put<{ identity: ServerIdentity }>("self/identity/statement", { statement: JSON.stringify(statement) });
  return openIdentity(r.identity)!;
}

export async function withdrawStatement(api: Api): Promise<void> {
  await api.del("self/identity/statement");
}

export async function saveRules(api: Api, vault: Unlocked, rules: WalletRules): Promise<WalletRules> {
  const clean = cleanWalletRules(rules);
  await api.put("settings/wallet", { value: await sealSetting(vault.key, "wallet", clean) });
  return clean;
}

// ---------------------------------------------------------------- the calls the owner's wallet sends

export const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

export const REGISTRY_ABI = parseAbi([
  "function register(address selfKey, string metadataURI, uint256 deadline, bytes selfSignature)",
  "function setWallet(address selfKey, address wallet)",
  "function revoke(address selfKey)",
  "function identityOf(address selfKey) view returns ((address owner, address wallet, uint64 registeredAt, uint64 revokedAt, string metadataURI))",
]);

export const WALLET_ABI = parseAbi([
  "function configure(uint256 perTxCap, uint256 perDayCap, uint64 expiresAt, address[] recipients, address[] targets, (address target, bytes4 selector)[] selectors, (address token, uint128 perTx, uint128 perDay)[] tokens)",
  "function freeze()",
  "function unfreeze()",
  "function revokeApprovals()",
  "function tokenLimit(address token) view returns (uint128 perTx, uint128 perDay)",
  "function tokenRemainingToday(address token) view returns (uint256)",
  "function openApprovals() view returns ((address token, address spender)[])",
  "function owner() view returns (address)",
  "function selfKey() view returns (address)",
  "function frozen() view returns (bool)",
  "function perTxCap() view returns (uint256)",
  "function perDayCap() view returns (uint256)",
  "function expiresAt() view returns (uint64)",
  "function remainingToday() view returns (uint256)",
]);

/** The call data of configure() for these rules: the owner's wallet sends it to the self wallet. */
export function configureCalldata(rules: WalletRules): Hex {
  const c = walletConfig(rules);
  return encodeFunctionData({
    abi: WALLET_ABI,
    functionName: "configure",
    args: [
      c.perTxCap,
      c.perDayCap,
      c.expiresAt,
      c.recipients as Hex[],
      c.targets as Hex[],
      c.selectors.map((s) => ({ target: s.target as Hex, selector: s.selector as Hex })),
      c.tokens.map((t) => ({ token: t.token as Hex, perTx: t.perTx, perDay: t.perDay })),
    ],
  });
}

/** The call data of register(): the self key signs on this device; the owner's wallet sends it. */
export async function registerCalldata(vault: Unlocked, chain: ChainConfig, owner: string, metadataURI: string, deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)): Promise<Hex> {
  const key = await selfIdentityKey(vault.raw);
  const sig = signDigest(key.secret, registerDigest({ chainId: BigInt(chain.chainId), registry: chain.registry, owner, selfKey: key.address, metadataURI, deadline }));
  return encodeFunctionData({ abi: REGISTRY_ABI, functionName: "register", args: [key.address as Hex, metadataURI, deadline, sig as Hex] });
}

export function freezeCalldata(): Hex {
  return encodeFunctionData({ abi: WALLET_ABI, functionName: "freeze" });
}

export function unfreezeCalldata(): Hex {
  return encodeFunctionData({ abi: WALLET_ABI, functionName: "unfreeze" });
}

/** Sets every allowance the self key gave back to zero (freezing does the same). */
export function revokeApprovalsCalldata(): Hex {
  return encodeFunctionData({ abi: WALLET_ABI, functionName: "revokeApprovals" });
}

export interface InjectedWallet {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** Sends one call from the owner's own browser wallet, on the registry's chain. Returns the transaction hash. */
export async function sendFromOwner(eth: InjectedWallet, chain: ChainConfig, to: string, data: Hex): Promise<string> {
  const [from] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const want = `0x${BigInt(chain.chainId).toString(16)}`;
  const have = String(await eth.request({ method: "eth_chainId" }));
  if (have.toLowerCase() !== want) await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  return String(await eth.request({ method: "eth_sendTransaction", params: [{ from, to, data }] }));
}

// ---------------------------------------------------------------- reading the chain, from this browser

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: Fetch = (i, init) => fetch(i, init);

interface RpcAnswer {
  id: number;
  result?: Hex;
  error?: { message: string };
}

async function rpc<T>(chain: ChainConfig, body: unknown, fetcher: Fetch): Promise<T> {
  if (!chain.rpcUrl) throw new Error("This site has no public read address for the chain.");
  const res = await fetcher(chain.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`The chain address answered ${res.status}.`);
  return (await res.json()) as T;
}

/** Several eth_call reads in one batch. Each answer is the raw result, or null when that call failed. */
async function callMany(chain: ChainConfig, calls: { to: string; data: Hex }[], fetcher: Fetch): Promise<(Hex | null)[]> {
  if (!calls.length) return [];
  const answers = await rpc<RpcAnswer[]>(
    chain,
    calls.map((c, id) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: c.to, data: c.data }, "latest"] })),
    fetcher,
  );
  const by = new Map((Array.isArray(answers) ? answers : []).map((a) => [a.id, a]));
  return calls.map((_, i) => {
    const r = by.get(i)?.result;
    return r && r !== "0x" ? r : null;
  });
}

export interface TokenInfo {
  address: string;
  decimals: number;
  symbol: string;
}

/**
 * A token's decimals and symbol, as the token itself answers on chain. The
 * caps of a token are scaled by its decimals, so a token that does not answer
 * is refused: its caps are never guessed.
 */
export async function readToken(chain: ChainConfig, token: string, fetcher: Fetch = defaultFetch): Promise<TokenInfo> {
  const t = token.trim();
  if (!isEvmAddress(t)) throw new Error("That is not an address (0x and 40 hex characters).");
  if (!chain.rpcUrl) throw new Error("A token's decimals are read from the token on chain, and this site has no read address for the chain yet. Tokens can be added once it has one.");
  let answers: (Hex | null)[];
  try {
    answers = await callMany(
      chain,
      [
        { to: t, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" }) },
        { to: t, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "symbol" }) },
      ],
      fetcher,
    );
  } catch (err) {
    throw new Error(`The token's decimals could not be read, so it was not added. ${(err as Error).message}`);
  }
  let decimals: number;
  try {
    decimals = Number(decodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", data: answers[0]! }));
  } catch {
    throw new Error("This address did not answer decimals() like a token, so it was not added. Check the address and the chain.");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`This token says it has ${decimals} decimals, which the wallet rules do not take.`);
  let symbol = "";
  try {
    symbol = answers[1] ? String(decodeFunctionResult({ abi: ERC20_ABI, functionName: "symbol", data: answers[1] })).replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 20) : "";
  } catch {
    symbol = "";
  }
  return { address: checksumAddress(t), decimals, symbol };
}

/** Checks every token of a draft against the decimals the token answers on chain. Throws on any difference, or when one cannot be read. */
export async function checkTokenDecimals(chain: ChainConfig, rules: WalletRules, fetcher: Fetch = defaultFetch): Promise<void> {
  const clean = cleanWalletRules(rules);
  if (!clean.tokens.length) return;
  const answers = await callMany(
    chain,
    clean.tokens.map((t) => ({ to: t.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" }) })),
    fetcher,
  );
  clean.tokens.forEach((t, i) => {
    let onChain: number;
    try {
      onChain = Number(decodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", data: answers[i]! }));
    } catch {
      throw new Error(`${t.label || t.address}: the token did not answer decimals(), so its caps cannot be set.`);
    }
    if (onChain !== t.decimals) throw new Error(`${t.label || t.address}: the token has ${onChain} decimals on chain, the draft says ${t.decimals}. Remove it and add it again.`);
  });
}

export interface TokenOnChain {
  token: string;
  perTx: bigint;
  perDay: bigint;
  remainingToday: bigint;
}

export interface OpenApproval {
  token: string;
  spender: string;
  /** What the spender may still take, or null when the token did not answer. */
  allowance: bigint | null;
}

export interface WalletState {
  owner: string;
  selfKey: string;
  frozen: boolean;
  perTxCap: bigint;
  perDayCap: bigint;
  expiresAt: bigint;
  remainingToday: bigint;
  /** The caps set on chain for the draft's tokens, in base units. */
  tokens: TokenOnChain[];
  /** Allowances the self key gave that may still be open. */
  approvals: OpenApproval[];
  spends: WalletSpend[];
  /** The oldest block the spends were read from. */
  spendsFromBlock: number;
  /** True when the spends go back to 00:00 UTC today (or the start of the chain). */
  coversToday: boolean;
}

const READS = ["owner", "selfKey", "frozen", "perTxCap", "perDayCap", "expiresAt", "remainingToday"] as const;

/** Blocks per eth_getLogs: the public node answers this many reliably (its limits are on results and time, not span). */
export const LOG_CHUNK = 100_000;

type RawLog = { topics: string[]; data: string; blockNumber: string; transactionHash: string };

/** The wallet's Executed logs in [from, to], halving the span when the node says the answer is too big. */
async function executedLogs(chain: ChainConfig, wallet: string, from: number, to: number, fetcher: Fetch): Promise<RawLog[]> {
  const r = await rpc<{ result?: RawLog[]; error?: { message: string } }>(
    chain,
    { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: wallet, topics: [EXECUTED_TOPIC], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] },
    fetcher,
  );
  if (r.result) return r.result;
  const message = r.error?.message ?? "The chain did not answer.";
  if (to > from && /exceed|too many|limit|range|timed out|timeout/i.test(message)) {
    const mid = Math.floor((from + to) / 2);
    return [...(await executedLogs(chain, wallet, mid + 1, to, fetcher)), ...(await executedLogs(chain, wallet, from, mid, fetcher))];
  }
  throw new Error(message);
}

async function blockTime(chain: ChainConfig, block: number, fetcher: Fetch): Promise<number> {
  const r = await rpc<{ result?: { timestamp: string } }>(chain, { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [`0x${block.toString(16)}`, false] }, fetcher);
  if (!r.result?.timestamp) throw new Error("The chain did not return that block.");
  return Number(BigInt(r.result.timestamp));
}

export interface SpendPage {
  spends: WalletSpend[];
  /** The oldest block read. */
  fromBlock: number;
  /** True when the reading went back past `untilTime`, or to block 0. */
  reached: boolean;
}

/**
 * Reads the wallet's spends newest first, in chunks of LOG_CHUNK blocks,
 * from `toBlock` back until a chunk starts at or before `untilTime` (Unix
 * seconds), block 0, or `maxChunks` chunks. Requests are spaced so the public
 * node does not rate-limit them.
 */
export async function readSpends(
  chain: ChainConfig,
  wallet: string,
  opts: { toBlock: number; untilTime: number | null; maxChunks?: number; floorBlock?: number; fetcher?: Fetch; pauseMs?: number },
): Promise<SpendPage> {
  const fetcher = opts.fetcher ?? defaultFetch;
  const floor = Math.max(0, opts.floorBlock ?? 0);
  const spends: WalletSpend[] = [];
  let to = opts.toBlock;
  let from = to;
  for (let n = 0; n < (opts.maxChunks ?? 12) && to >= floor; n++) {
    from = Math.max(floor, to - LOG_CHUNK + 1);
    const logs = await executedLogs(chain, wallet, from, to, fetcher);
    spends.push(
      ...logs
        .map(decodeSpendLog)
        .filter((s): s is WalletSpend => !!s)
        .reverse(),
    );
    if (from === floor) return { spends, fromBlock: from, reached: true };
    if (opts.untilTime !== null && (await blockTime(chain, from, fetcher)) <= opts.untilTime) return { spends, fromBlock: from, reached: true };
    to = from - 1;
    if (opts.pauseMs ?? 120) await new Promise((r) => setTimeout(r, opts.pauseMs ?? 120));
  }
  return { spends, fromBlock: from, reached: false };
}

/** 00:00 UTC of the day `now` falls in, in Unix seconds: the wallet's day caps reset then. */
export function utcDayStart(now = Date.now()): number {
  return Math.floor(now / 86_400_000) * 86_400;
}

/**
 * The wallet as set on chain, read through the site's public read address:
 * its caps, what is left today, the caps of the draft's tokens, the
 * allowances the self key gave that may still be open, and its spends since
 * 00:00 UTC today.
 */
export async function readWallet(chain: ChainConfig, wallet: string, opts: { tokens?: string[]; fetcher?: Fetch; now?: number; pauseMs?: number } = {}): Promise<WalletState> {
  const fetcher = opts.fetcher ?? defaultFetch;
  const tokens = (opts.tokens ?? []).filter(isEvmAddress);
  const calls = [
    ...READS.map((fn) => ({ to: wallet, data: encodeFunctionData({ abi: WALLET_ABI, functionName: fn }) })),
    { to: wallet, data: encodeFunctionData({ abi: WALLET_ABI, functionName: "openApprovals" }) },
    ...tokens.flatMap((t) => [
      { to: wallet, data: encodeFunctionData({ abi: WALLET_ABI, functionName: "tokenLimit", args: [t as Hex] }) },
      { to: wallet, data: encodeFunctionData({ abi: WALLET_ABI, functionName: "tokenRemainingToday", args: [t as Hex] }) },
    ]),
  ];
  const [answers, head] = await Promise.all([callMany(chain, calls, fetcher), rpc<{ result?: Hex }>(chain, { jsonrpc: "2.0", id: 99, method: "eth_blockNumber", params: [] }, fetcher)]);
  const read = (i: number) => {
    if (!answers[i]) throw new Error("The wallet could not be read. Is the address right, and is it a self wallet?");
    return decodeFunctionResult({ abi: WALLET_ABI, functionName: READS[i], data: answers[i]! }) as unknown;
  };
  const base = READS.length;
  const listed = answers[base] ? (decodeFunctionResult({ abi: WALLET_ABI, functionName: "openApprovals", data: answers[base]! }) as readonly { token: string; spender: string }[]) : [];
  const tokenStates: TokenOnChain[] = tokens.map((t, j) => {
    const lim = answers[base + 1 + j * 2];
    const left = answers[base + 2 + j * 2];
    const [perTx, perDay] = lim ? (decodeFunctionResult({ abi: WALLET_ABI, functionName: "tokenLimit", data: lim }) as readonly [bigint, bigint]) : [0n, 0n];
    return { token: checksumAddress(t), perTx, perDay, remainingToday: left ? (decodeFunctionResult({ abi: WALLET_ABI, functionName: "tokenRemainingToday", data: left }) as bigint) : 0n };
  });
  const allowances = await callMany(
    chain,
    listed.map((a) => ({ to: a.token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "allowance", args: [wallet as Hex, a.spender as Hex] }) })),
    fetcher,
  );
  const latest = Number(BigInt(head.result ?? "0x0"));
  const page = await readSpends(chain, wallet, { toBlock: latest, untilTime: utcDayStart(opts.now), fetcher, pauseMs: opts.pauseMs });
  return {
    owner: String(read(0)),
    selfKey: String(read(1)),
    frozen: Boolean(read(2)),
    perTxCap: read(3) as bigint,
    perDayCap: read(4) as bigint,
    expiresAt: read(5) as bigint,
    remainingToday: read(6) as bigint,
    tokens: tokenStates,
    approvals: listed.map((a, i) => ({
      token: checksumAddress(a.token),
      spender: checksumAddress(a.spender),
      allowance: allowances[i] ? (decodeFunctionResult({ abi: ERC20_ABI, functionName: "allowance", data: allowances[i]! }) as bigint) : null,
    })),
    spends: page.spends,
    spendsFromBlock: page.fromBlock,
    coversToday: page.reached,
  };
}
