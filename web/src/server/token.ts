// The network token's page, read straight from its contracts. Nothing here is on until the launch: every value,
// the token's symbol included, comes from the environment, so neither the site nor this repository names the token
// before it is live (nobody can launch a copy under the right name ahead of it).
//
//   SIGIL_TOKEN=on                 shows the page and its menu link
//   SIGIL_TOKEN_SYMBOL             the ticker as people write it, for example with a leading $
//   SIGIL_TOKEN_ADDRESS            the token contract
//   SIGIL_BURN_POT                 the burn pot contract (burns at most every 30 minutes)
//   SIGIL_TOKEN_BLOCK              the block the pot was deployed in, where reading its burns starts
//   SIGIL_TOKEN_RPC                a public read-only RPC of the chain the token lives on
//   SIGIL_TOKEN_EXPLORER           the explorer base address, for links to the contract and every burn
//   SIGIL_TOKEN_TRADE_URL          where it trades
import { createPublicClient, formatEther, http, parseAbi, parseAbiItem, type Address, type Hex } from "viem";

export interface TokenConfig {
  on: boolean;
  symbol: string;
  token: Address | null;
  pot: Address | null;
  fromBlock: bigint;
  rpc: string;
  explorer: string;
  tradeUrl: string;
}

export function tokenConfig(env: Record<string, string | undefined> = process.env): TokenConfig {
  const addr = (v?: string) => (v && /^0x[0-9a-fA-F]{40}$/.test(v.trim()) ? (v.trim() as Address) : null);
  return {
    on: env.SIGIL_TOKEN === "on",
    symbol: (env.SIGIL_TOKEN_SYMBOL || "").trim(),
    token: addr(env.SIGIL_TOKEN_ADDRESS),
    pot: addr(env.SIGIL_BURN_POT),
    fromBlock: BigInt(Math.max(0, Number(env.SIGIL_TOKEN_BLOCK || 0) || 0)),
    rpc: (env.SIGIL_TOKEN_RPC || "").trim(),
    explorer: (env.SIGIL_TOKEN_EXPLORER || "").trim().replace(/\/$/, ""),
    tradeUrl: (env.SIGIL_TOKEN_TRADE_URL || "").trim(),
  };
}

/** Shown only when it is switched on and every address it needs is set. */
export function tokenLive(c: TokenConfig = tokenConfig()): boolean {
  return c.on && !!c.symbol && !!c.token && !!c.pot && !!c.rpc;
}

export interface Burn { n: number; at: number; eth: number; tokens: number; tx: Hex }
export interface TokenState {
  supplyLeft: number;
  burnedTokens: number;
  burnCount: number;
  ethSpent: number;
  potEth: number;
  lastBurnAt: number | null;
  nextBurnAt: number | null;
  burns: Burn[];
  asOf: number;
}

const POT = parseAbi([
  "function burnCount() view returns (uint256)",
  "function totalEthBurned() view returns (uint256)",
  "function totalTokensBurned() view returns (uint256)",
  "function lastBurnAt() view returns (uint256)",
  "function preview() view returns (uint256 amount, uint256 nextAt, bool ready, uint256 tokens)",
]);
const TOKEN = parseAbi(["function totalSupply() view returns (uint256)"]);
const BURNED = parseAbiItem("event Burned(uint256 indexed n, address indexed caller, uint256 ethIn, uint256 tokensBurned, bool viaCurve)");
const LOG_SPAN = 9_000n; // the chain's RPC caps how many blocks one log query may cover

let cache: { at: number; state: TokenState } | null = null;

/** The token's numbers and its burns, read from the chain at most once a minute. */
export async function readToken(c: TokenConfig = tokenConfig()): Promise<TokenState | null> {
  if (!tokenLive(c)) return null;
  if (cache && Date.now() - cache.at < 60_000) return cache.state;
  const client = createPublicClient({ transport: http(c.rpc, { timeout: 15_000 }) });
  const pot = c.pot!, token = c.token!;
  const [count, ethBurned, tokensBurned, last, preview, supply, potWei, head] = await Promise.all([
    client.readContract({ address: pot, abi: POT, functionName: "burnCount" }),
    client.readContract({ address: pot, abi: POT, functionName: "totalEthBurned" }),
    client.readContract({ address: pot, abi: POT, functionName: "totalTokensBurned" }),
    client.readContract({ address: pot, abi: POT, functionName: "lastBurnAt" }),
    client.readContract({ address: pot, abi: POT, functionName: "preview" }).catch(() => null),
    client.readContract({ address: token, abi: TOKEN, functionName: "totalSupply" }),
    client.getBalance({ address: pot }),
    client.getBlockNumber(),
  ]);
  // The newest burns: walk back from the head in spans the RPC accepts, until 50 are found or the start is reached.
  const burns: Burn[] = [];
  const times = new Map<bigint, number>();
  for (let to = head; to >= c.fromBlock && burns.length < 50; to -= LOG_SPAN) {
    const from = to - LOG_SPAN + 1n > c.fromBlock ? to - LOG_SPAN + 1n : c.fromBlock;
    const logs = await client.getLogs({ address: pot, event: BURNED, fromBlock: from, toBlock: to });
    for (const l of logs.reverse()) {
      if (!times.has(l.blockNumber)) times.set(l.blockNumber, Number((await client.getBlock({ blockNumber: l.blockNumber })).timestamp) * 1000);
      burns.push({ n: Number(l.args.n), at: times.get(l.blockNumber)!, eth: Number(formatEther(l.args.ethIn ?? 0n)), tokens: Number(formatEther(l.args.tokensBurned ?? 0n)), tx: l.transactionHash });
      if (burns.length >= 50) break;
    }
    if (from === c.fromBlock) break;
  }
  const state: TokenState = {
    supplyLeft: Number(formatEther(supply)),
    burnedTokens: Number(formatEther(tokensBurned)),
    burnCount: Number(count),
    ethSpent: Number(formatEther(ethBurned)),
    potEth: Number(formatEther(potWei)),
    lastBurnAt: last > 0n ? Number(last) * 1000 : null,
    nextBurnAt: preview && preview[1] > 0n ? Number(preview[1]) * 1000 : null,
    burns,
    asOf: Date.now(),
  };
  cache = { at: Date.now(), state };
  return state;
}
