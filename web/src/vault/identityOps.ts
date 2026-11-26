// The AI self's identity on the owner's device: the self key (derived from the
// vault key, never stored), the identity statement signed by the vault key and
// the self key, the rules of its wallet (encrypted like every setting), and,
// once the site has a registry on chain, the calls the owner's own wallet sends
// and the wallet's state and spends read through a public read-only address.
// Nothing here holds or sends a private key.

import { decodeErrorResult, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, type Hex } from "viem";
import {
  checksumAddress,
  cleanWalletRules,
  decodeSpendLog,
  executeDigest,
  EXECUTED_TOPIC,
  formatUnits,
  functionSelector,
  parseUnits,
  sameAddress,
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
import { SELF_WALLET_BYTECODE } from "./selfWalletCode";
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
  "function pendingOwner(address selfKey) view returns (address)",
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
  "function nonce() view returns (uint256)",
  "function isRecipient(address recipient) view returns (bool)",
  "function isTargetAllowed(address target) view returns (bool)",
  "function isSelectorAllowed(address target, bytes4 selector) view returns (bool)",
  "function cancelSignedCalls()",
  "function withdraw(address to, uint256 amount)",
  "function withdrawToken(address token, address to, uint256 amount)",
  "function execute(address target, uint256 value, bytes data) returns (bytes)",
  "function executeWithSig(address target, uint256 value, bytes data, uint256 deadline, uint256 gas, bytes signature) returns (bytes)",
  "error NotOwner()",
  "error NotSelf()",
  "error NotOwnerOrSelf()",
  "error ZeroAddress()",
  "error IsFrozen()",
  "error RulesExpired()",
  "error Expired()",
  "error BadSignature()",
  "error TargetNotAllowed(address target)",
  "error SelectorNotAllowed(address target, bytes4 selector)",
  "error TokenNotAllowed(address token)",
  "error RecipientNotAllowed(address to)",
  "error TokenMoveRefused(bytes4 selector)",
  "error OverTxCap(uint256 amount, uint256 cap)",
  "error OverDayCap(uint256 spent, uint256 cap)",
  "error CallFailed(bytes reason)",
  "error RecipientAndContract(address account)",
  "error TooManyOpenApprovals()",
  "error NotEnoughGas()",
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

export function cancelSignedCalldata(): Hex {
  return encodeFunctionData({ abi: WALLET_ABI, functionName: "cancelSignedCalls" });
}

/** The owner takes the chain's coin out of the self wallet. */
export function withdrawCalldata(to: string, amount: bigint): Hex {
  return encodeFunctionData({ abi: WALLET_ABI, functionName: "withdraw", args: [to as Hex, amount] });
}

export function withdrawTokenCalldata(token: string, to: string, amount: bigint): Hex {
  return encodeFunctionData({ abi: WALLET_ABI, functionName: "withdrawToken", args: [token as Hex, to as Hex, amount] });
}

export function setWalletCalldata(selfKey: string, wallet: string): Hex {
  return encodeFunctionData({ abi: REGISTRY_ABI, functionName: "setWallet", args: [selfKey as Hex, wallet as Hex] });
}

/** The creation code of the self's wallet for this owner and self key: the owner's browser wallet sends it as a deploy. */
export function deployWalletData(owner: string, selfKey: string): Hex {
  return `${SELF_WALLET_BYTECODE}${encodeAbiParameters(parseAbiParameters("address owner, address selfKey"), [owner as Hex, selfKey as Hex]).slice(2)}` as Hex;
}

export interface InjectedWallet {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function walletError(err: unknown): Error {
  const e = err as { code?: number; message?: string };
  if (e?.code === 4001) return new Error("You declined the request in your wallet.");
  if (e?.code === -32002) return new Error("Your wallet already has a request open. Check the wallet window.");
  return err instanceof Error ? err : new Error(e?.message ?? "The wallet request failed.");
}

/** The address the owner's browser wallet uses, on the registry's chain (it is asked to switch when it is on another). */
export async function ownerAccount(eth: InjectedWallet, chain: ChainConfig): Promise<string> {
  try {
    const [from] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    if (!from) throw new Error("The wallet did not share an address.");
    const want = `0x${BigInt(chain.chainId).toString(16)}`;
    const have = String(await eth.request({ method: "eth_chainId" }));
    if (have.toLowerCase() !== want) await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
    return checksumAddress(from);
  } catch (err) {
    throw walletError(err);
  }
}

/**
 * Sends one transaction from the owner's own browser wallet, on the registry's
 * chain: a call (to an address), a deploy (to null), or a payment (with value).
 * Returns the transaction hash.
 */
export async function sendFromOwner(eth: InjectedWallet, chain: ChainConfig, to: string | null, data: Hex, value = 0n, gas?: bigint): Promise<string> {
  const from = await ownerAccount(eth, chain);
  try {
    const tx: Record<string, string> = { from, data };
    if (to) tx.to = to;
    if (value > 0n) tx.value = `0x${value.toString(16)}`;
    if (gas) tx.gas = `0x${gas.toString(16)}`;
    return String(await eth.request({ method: "eth_sendTransaction", params: [tx] }));
  } catch (err) {
    throw walletError(err);
  }
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

/**
 * The gas to send with freeze() or revokeApprovals() so that every open allowance is tried.
 * The wallet sets each one back with up to 100,000 gas and needs 130,000 left before it tries;
 * a node's own estimate would land on the cheapest path, which tries none.
 */
export function revokeGasLimit(openApprovals: number): bigint {
  return 180_000n + BigInt(Math.max(0, openApprovals)) * 150_000n;
}

/** How many allowances the self gave that the wallet still lists, read fresh from the chain. */
export async function openApprovalCount(chain: ChainConfig, wallet: string, fetcher: Fetch = defaultFetch): Promise<number> {
  const [answer] = await callMany(chain, [{ to: wallet, data: encodeFunctionData({ abi: WALLET_ABI, functionName: "openApprovals" }) }], fetcher);
  if (!answer) throw new Error("The wallet's open allowances could not be read. Try again.");
  return (decodeFunctionResult({ abi: WALLET_ABI, functionName: "openApprovals", data: answer }) as readonly unknown[]).length;
}

/** Recipients are people's addresses: a contract is refused, since what it does with a payment is up to its code. */
export async function checkRecipientsAreNotContracts(chain: ChainConfig, rules: WalletRules, fetcher: Fetch = defaultFetch): Promise<void> {
  const list = cleanWalletRules(rules).recipients;
  if (!list.length) return;
  const answers = await rpc<RpcAnswer[]>(
    chain,
    list.map((r, id) => ({ jsonrpc: "2.0", id, method: "eth_getCode", params: [r.address, "latest"] })),
    fetcher,
  );
  const by = new Map((Array.isArray(answers) ? answers : []).map((a) => [a.id, a]));
  list.forEach((r, i) => {
    const code = by.get(i)?.result;
    if (typeof code !== "string") throw new Error(`${r.label || r.address}: the chain did not say whether this address is a contract. Try again.`);
    if (code !== "0x" && !isDelegatedAccount(code)) {
      throw new Error(`${r.label || r.address} is a contract. Recipients are addresses of people; list a contract under Contracts instead.`);
    }
  });
}

/** An account that delegates to code under EIP-7702 (0xef0100 + address) is still a person's account. */
function isDelegatedAccount(code: string): boolean {
  return /^0xef0100[0-9a-fA-F]{40}$/.test(code);
}

export interface TokenOnChain {
  token: string;
  perTx: bigint;
  perDay: bigint;
  remainingToday: bigint;
  /** The caps could not be read; the numbers above mean nothing then. */
  unread?: boolean;
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
    let got = logs
      .map(decodeSpendLog)
      .filter((s): s is WalletSpend => !!s)
      .reverse();
    // The span that crosses untilTime is cut by block, not by time: each of its spends is kept
    // only if its own block is at or after untilTime, so "since 00:00 UTC" means exactly that.
    const crosses = opts.untilTime !== null && (await blockTime(chain, from, fetcher)) <= opts.untilTime;
    if (crosses && got.length) {
      const times = new Map<number, number>();
      for (const b of new Set(got.map((s) => s.block))) times.set(b, await blockTime(chain, b, fetcher));
      got = got.filter((s) => times.get(s.block)! >= opts.untilTime!);
    }
    spends.push(...got);
    if (crosses) return { spends, fromBlock: from, reached: true };
    if (from === floor) return { spends, fromBlock: from, reached: true };
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
  // The latest block gives both where to read back from and what day it is on chain, so a
  // device with a wrong clock still shows the right day's spends.
  const [answers, head] = await Promise.all([
    callMany(chain, calls, fetcher),
    rpc<{ result?: { number?: Hex; timestamp?: Hex } }>(chain, { jsonrpc: "2.0", id: 99, method: "eth_getBlockByNumber", params: ["latest", false] }, fetcher),
  ]);
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
    return {
      token: checksumAddress(t),
      perTx,
      perDay,
      remainingToday: left ? (decodeFunctionResult({ abi: WALLET_ABI, functionName: "tokenRemainingToday", data: left }) as bigint) : 0n,
      ...(lim && left ? {} : { unread: true }),
    };
  });
  const allowances = await callMany(
    chain,
    listed.map((a) => ({ to: a.token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "allowance", args: [wallet as Hex, a.spender as Hex] }) })),
    fetcher,
  );
  if (!head.result?.number || !head.result.timestamp) throw new Error("The chain did not return its latest block. Try again.");
  const latest = Number(BigInt(head.result.number));
  const chainNow = Number(BigInt(head.result.timestamp)) * 1000;
  const page = await readSpends(chain, wallet, { toBlock: latest, untilTime: utcDayStart(opts.now ?? chainNow), fetcher, pauseMs: opts.pauseMs });
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

// ---------------------------------------------------------------- the whole flow on chain

export interface TxReceipt {
  status: "success" | "failed";
  block: number;
  contractAddress: string | null;
}

/**
 * Waits until a transaction is in a block, asking the site's read address (or
 * the owner's wallet when the site has none). Throws when it failed on chain.
 */
export async function waitForTx(chain: ChainConfig, hash: string, opts: { eth?: InjectedWallet; fetcher?: Fetch; timeoutMs?: number; everyMs?: number } = {}): Promise<TxReceipt> {
  const fetcher = opts.fetcher ?? defaultFetch;
  const until = Date.now() + (opts.timeoutMs ?? 180_000);
  for (;;) {
    type Raw = { status?: string; blockNumber?: string; contractAddress?: string | null };
    let r: Raw | null = null;
    if (chain.rpcUrl) r = (await rpc<{ result?: Raw | null }>(chain, { jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }, fetcher)).result ?? null;
    else if (opts.eth) r = (await opts.eth.request({ method: "eth_getTransactionReceipt", params: [hash] })) as Raw | null;
    if (r && r.blockNumber) {
      const out: TxReceipt = { status: r.status === "0x1" ? "success" : "failed", block: Number(BigInt(r.blockNumber)), contractAddress: r.contractAddress ? checksumAddress(r.contractAddress) : null };
      if (out.status === "failed") throw new Error("The transaction was sent but failed on chain. Nothing changed.");
      return out;
    }
    if (Date.now() > until) throw new Error("The transaction is not in a block yet. Check your wallet, then read again.");
    await new Promise((res) => setTimeout(res, opts.everyMs ?? 1200));
  }
}

export interface RegistryEntry {
  owner: string;
  wallet: string | null;
  registeredAt: number;
  revokedAt: number;
  metadataURI: string;
  pendingOwner: string | null;
}

/** What the registry says about this self key, or null when it is not registered. */
export async function readRegistry(chain: ChainConfig, selfKey: string, fetcher: Fetch = defaultFetch): Promise<RegistryEntry | null> {
  const [id, pending] = await callMany(
    chain,
    [
      { to: chain.registry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: "identityOf", args: [selfKey as Hex] }) },
      { to: chain.registry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: "pendingOwner", args: [selfKey as Hex] }) },
    ],
    fetcher,
  );
  if (!id) throw new Error("The registry could not be read. Is the site's registry address right?");
  const v = decodeFunctionResult({ abi: REGISTRY_ABI, functionName: "identityOf", data: id }) as { owner: string; wallet: string; registeredAt: bigint; revokedAt: bigint; metadataURI: string };
  if (/^0x0{40}$/i.test(v.owner)) return null;
  const p = pending ? String(decodeFunctionResult({ abi: REGISTRY_ABI, functionName: "pendingOwner", data: pending })) : "";
  return {
    owner: checksumAddress(v.owner),
    wallet: /^0x0{40}$/i.test(v.wallet) ? null : checksumAddress(v.wallet),
    registeredAt: Number(v.registeredAt),
    revokedAt: Number(v.revokedAt),
    metadataURI: v.metadataURI,
    pendingOwner: p && !/^0x0{40}$/i.test(p) ? checksumAddress(p) : null,
  };
}

/** The chain's coin a self wallet holds, in base units. */
export async function walletBalance(chain: ChainConfig, wallet: string, fetcher: Fetch = defaultFetch): Promise<bigint> {
  const r = await rpc<{ result?: Hex }>(chain, { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [wallet, "latest"] }, fetcher);
  return BigInt(r.result ?? "0x0");
}

export interface RuleRow {
  /** What the rule is, in a few words. */
  what: string;
  /** As the draft has it, and as the wallet holds it on chain. */
  draft: string;
  chain: string;
  same: boolean;
}

/** Each rule of the draft next to what the wallet holds on chain, so the owner sees what the chain enforces. */
export async function compareRules(chain: ChainConfig, wallet: string, input: WalletRules, fetcher: Fetch = defaultFetch): Promise<RuleRow[]> {
  const rules = cleanWalletRules(input);
  const cfg = walletConfig(rules);
  const calls: { to: string; data: Hex }[] = [
    { to: wallet, data: encodeFunctionData({ abi: WALLET_ABI, functionName: "perTxCap" }) },
    { to: wallet, data: encodeFunctionData({ abi: WALLET_ABI, functionName: "perDayCap" }) },
    { to: wallet, data: encodeFunctionData({ abi: WALLET_ABI, functionName: "expiresAt" }) },
    ...rules.recipients.map((r) => ({ to: wallet, data: encodeFunctionData({ abi: WALLET_ABI, functionName: "isRecipient", args: [r.address as Hex] }) })),
    ...cfg.targets.map((t) => ({ to: wallet, data: encodeFunctionData({ abi: WALLET_ABI, functionName: "isTargetAllowed", args: [t as Hex] }) })),
    ...cfg.selectors.map((x) => ({ to: wallet, data: encodeFunctionData({ abi: WALLET_ABI, functionName: "isSelectorAllowed", args: [x.target as Hex, x.selector as Hex] }) })),
    ...rules.tokens.map((t) => ({ to: wallet, data: encodeFunctionData({ abi: WALLET_ABI, functionName: "tokenLimit", args: [t.address as Hex] }) })),
  ];
  const a = await callMany(chain, calls, fetcher);
  if (!a[0]) throw new Error("The wallet could not be read. Is the address right, and is it a self wallet?");
  let i = 0;
  const next = <T>(fn: Parameters<typeof decodeFunctionResult<typeof WALLET_ABI>>[0]["functionName"]): T => decodeFunctionResult({ abi: WALLET_ABI, functionName: fn, data: a[i++] ?? "0x" }) as T;
  const yes = (b: boolean) => (b ? "Listed" : "Not listed");
  const rows: RuleRow[] = [];
  const perTx = next<bigint>("perTxCap");
  const perDay = next<bigint>("perDayCap");
  const expires = next<bigint>("expiresAt");
  rows.push({ what: "Per payment", draft: rules.perTx, chain: formatUnits(perTx), same: perTx === cfg.perTxCap });
  rows.push({ what: "Per day", draft: rules.perDay, chain: formatUnits(perDay), same: perDay === cfg.perDayCap });
  const day = (n: bigint) => (n === 0n ? "No end" : new Date(Number(n) * 1000).toISOString().slice(0, 10));
  rows.push({ what: "Until", draft: day(cfg.expiresAt), chain: day(expires), same: expires === cfg.expiresAt });
  for (const r of rules.recipients) {
    const on = next<boolean>("isRecipient");
    rows.push({ what: `Recipient ${r.label || r.address}`, draft: "Listed", chain: yes(on), same: on });
  }
  const names = new Map([...rules.contracts.map((c) => [c.address, c.label] as const), ...rules.tokens.map((t) => [t.address, t.label] as const)]);
  for (const t of cfg.targets) {
    const on = next<boolean>("isTargetAllowed");
    rows.push({ what: `Contract ${names.get(t) || t}`, draft: "Listed", chain: yes(on), same: on });
  }
  const fnName = new Map(rules.contracts.flatMap((c) => c.functions.map((f) => [`${c.address}:${functionSelector(f)}`, f] as const)));
  for (const x of cfg.selectors) {
    const on = next<boolean>("isSelectorAllowed");
    const fn = fnName.get(`${x.target}:${x.selector}`) ?? (x.selector === "0xa9059cbb" ? "transfer" : x.selector === "0x095ea7b3" ? "approve" : x.selector);
    rows.push({ what: `${names.get(x.target) || x.target}: ${fn}`, draft: "Allowed", chain: on ? "Allowed" : "Not allowed", same: on });
  }
  for (const t of rules.tokens) {
    const [tx, dayCap] = next<readonly [bigint, bigint]>("tokenLimit");
    const want = cfg.tokens.find((x) => sameAddress(x.token, t.address))!;
    rows.push({
      what: `${t.label || t.address} caps`,
      draft: `${t.perTx} and ${t.perDay}`,
      chain: `${formatUnits(tx, t.decimals)} and ${formatUnits(dayCap, t.decimals)}`,
      same: tx === want.perTx && dayCap === want.perDay,
    });
  }
  return rows;
}

const ERROR_TEXT: Record<string, string> = {
  IsFrozen: "The wallet is frozen.",
  RulesExpired: "The rules have expired.",
  TargetNotAllowed: "This contract is not on the list of contracts.",
  RecipientNotAllowed: "This address is not one of the recipients.",
  SelectorNotAllowed: "That function is not allowed on this contract.",
  TokenNotAllowed: "This token has no caps, so it cannot be moved.",
  TokenMoveRefused: "The wallet never lets the self call this function.",
  OverTxCap: "Over the cap per transaction.",
  OverDayCap: "Over the cap per day.",
  CallFailed: "The rules allow it, but the payment itself failed: the wallet may hold too little.",
  NotSelf: "The wallet has another self key.",
  BadSignature: "The self key's signature does not fit this wallet.",
  Expired: "The signature is too old.",
  TooManyOpenApprovals: "Too many allowances are open. Set them to zero first.",
  NotEnoughGas: "Too little gas was sent for this call.",
};

/** A wallet's refusal in plain words, from the revert data of a call. */
export function refusalText(data: string | undefined | null): string {
  if (data && data.length >= 10) {
    try {
      const e = decodeErrorResult({ abi: WALLET_ABI, data: data as Hex });
      return ERROR_TEXT[e.errorName] ?? "The wallet refused it.";
    } catch {
      return "The call failed.";
    }
  }
  return "The wallet refused it.";
}

export interface SelfCall {
  target: string;
  value: bigint;
  data: Hex;
}

/** The call the self key makes for a payment: the chain's coin straight to the recipient, or a token's transfer. */
export function paymentCall(to: string, amount: string, token: { address: string; decimals: number } | null): SelfCall {
  if (!token) return { target: checksumAddress(to), value: parseUnits(amount), data: "0x" };
  return { target: checksumAddress(token.address), value: 0n, data: encodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]), args: [to as Hex, parseUnits(amount, token.decimals)] }) };
}

/**
 * What the wallet on chain says to a call by the self key, right now: the
 * call is run as the self key against the wallet's real rules, caps and
 * balance (eth_call, nothing is sent). Null when it would go through,
 * otherwise the refusal in plain words.
 */
export async function tryOnChain(chain: ChainConfig, wallet: string, selfKey: string, call: SelfCall, fetcher: Fetch = defaultFetch): Promise<string | null> {
  const r = await rpc<{ result?: Hex; error?: { message?: string; data?: unknown } }>(
    chain,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ from: selfKey, to: wallet, data: encodeFunctionData({ abi: WALLET_ABI, functionName: "execute", args: [call.target as Hex, call.value, call.data] }) }, "latest"],
    },
    fetcher,
  );
  if (r.error) {
    const d = r.error.data;
    const hex = typeof d === "string" ? d : d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string" ? String((d as { data: string }).data) : null;
    return refusalText(hex);
  }
  return null;
}

/** The wallet's next nonce for signed calls. */
export async function walletNonce(chain: ChainConfig, wallet: string, fetcher: Fetch = defaultFetch): Promise<bigint> {
  const [n] = await callMany(chain, [{ to: wallet, data: encodeFunctionData({ abi: WALLET_ABI, functionName: "nonce" }) }], fetcher);
  if (!n) throw new Error("The wallet could not be read.");
  return decodeFunctionResult({ abi: WALLET_ABI, functionName: "nonce", data: n }) as bigint;
}

/**
 * Signs a call with the self key, on this device (EIP-712, as the wallet
 * checks it), and returns the executeWithSig call data anyone may submit. The
 * owner's own wallet submits it here, so the self key never needs gas.
 */
export async function signSelfCall(vault: Unlocked, chain: ChainConfig, wallet: string, call: SelfCall, nonce: bigint, opts: { deadline?: bigint; gas?: bigint } = {}): Promise<Hex> {
  const key = await selfIdentityKey(vault.raw);
  const deadline = opts.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 3600);
  const gas = opts.gas ?? 0n;
  const digest = executeDigest({ chainId: BigInt(chain.chainId), wallet, target: call.target, value: call.value, data: call.data, nonce, deadline, gas });
  const sig = signDigest(key.secret, digest);
  return encodeFunctionData({ abi: WALLET_ABI, functionName: "executeWithSig", args: [call.target as Hex, call.value, call.data, deadline, gas, sig as Hex] });
}
