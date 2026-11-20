// The AI self's identity on the owner's device: the self key (derived from the
// vault key, never stored), the identity statement signed by the vault key and
// the self key, the rules of its wallet (encrypted like every setting), and,
// once the site has a registry on chain, the calls the owner's own wallet sends
// and the wallet's state and spends read through a public read-only address.
// Nothing here holds or sends a private key.

import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import {
  cleanWalletRules,
  decodeSpendLog,
  EXECUTED_TOPIC,
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

export const REGISTRY_ABI = parseAbi([
  "function register(address selfKey, string metadataURI, uint256 deadline, bytes selfSignature)",
  "function setWallet(address selfKey, address wallet)",
  "function revoke(address selfKey)",
  "function identityOf(address selfKey) view returns ((address owner, address wallet, uint64 registeredAt, uint64 revokedAt, string metadataURI))",
]);

export const WALLET_ABI = parseAbi([
  "function configure(uint256 perTxCap, uint256 perDayCap, uint64 expiresAt, address[] targets, (address target, bytes4 selector)[] selectors, (address token, uint128 perTx, uint128 perDay)[] tokens)",
  "function freeze()",
  "function unfreeze()",
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

// ---------------------------------------------------------------- reading the wallet, from this browser

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface WalletState {
  owner: string;
  selfKey: string;
  frozen: boolean;
  perTxCap: bigint;
  perDayCap: bigint;
  expiresAt: bigint;
  remainingToday: bigint;
  spends: WalletSpend[];
}

const READS = ["owner", "selfKey", "frozen", "perTxCap", "perDayCap", "expiresAt", "remainingToday"] as const;

async function rpc<T>(chain: ChainConfig, body: unknown, fetcher: Fetch): Promise<T> {
  if (!chain.rpcUrl) throw new Error("This site has no public read address for the chain.");
  const res = await fetcher(chain.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`The chain address answered ${res.status}.`);
  return (await res.json()) as T;
}

/** The wallet's rules as set on chain and its spends, read through the site's public read address. */
export async function readWallet(chain: ChainConfig, wallet: string, fetcher: Fetch = (i, init) => fetch(i, init), blocks = 50_000): Promise<WalletState> {
  const calls = READS.map((fn, id) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: wallet, data: encodeFunctionData({ abi: WALLET_ABI, functionName: fn }) }, "latest"] }));
  const answers = await rpc<{ id: number; result?: Hex; error?: { message: string } }[]>(chain, [...calls, { jsonrpc: "2.0", id: 99, method: "eth_blockNumber", params: [] }], fetcher);
  const by = new Map(answers.map((a) => [a.id, a]));
  const read = (i: number) => {
    const a = by.get(i);
    if (!a?.result) throw new Error(a?.error?.message ?? "The wallet could not be read. Is the address right?");
    return decodeFunctionResult({ abi: WALLET_ABI, functionName: READS[i], data: a.result }) as unknown;
  };
  const latest = BigInt(by.get(99)?.result ?? "0x0");
  const from = latest > BigInt(blocks) ? latest - BigInt(blocks) : 0n;
  const logs = await rpc<{ result?: { topics: string[]; data: string; blockNumber: string; transactionHash: string }[]; error?: { message: string } }>(
    chain,
    { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: wallet, topics: [EXECUTED_TOPIC], fromBlock: `0x${from.toString(16)}`, toBlock: "latest" }] },
    fetcher,
  );
  return {
    owner: String(read(0)),
    selfKey: String(read(1)),
    frozen: Boolean(read(2)),
    perTxCap: read(3) as bigint,
    perDayCap: read(4) as bigint,
    expiresAt: read(5) as bigint,
    remainingToday: read(6) as bigint,
    spends: (logs.result ?? [])
      .map(decodeSpendLog)
      .filter((s): s is WalletSpend => !!s)
      .reverse(),
  };
}
