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
//   SIGIL_DEV_BURN_TX              the dev wallet's burn of its own bag (sent to the dead address), shown as its own row
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
  devBurnTx: Hex | null;
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
    devBurnTx: /^0x[0-9a-fA-F]{64}$/.test((env.SIGIL_DEV_BURN_TX || "").trim()) ? (env.SIGIL_DEV_BURN_TX!.trim() as Hex) : null,
  };
}

/** Shown only when it is switched on and every address it needs is set. */
export function tokenLive(c: TokenConfig = tokenConfig()): boolean {
  return c.on && !!c.symbol && !!c.token && !!c.pot && !!c.rpc;
}

export interface Burn { n: number; at: number; eth: number; tokens: number; tx: Hex; dev?: boolean }
export interface TokenState {
  supplyLeft: number;
  burnedTokens: number;
  burnCount: number;
  ethSpent: number;
  potEth: number;
  lastBurnAt: number | null;
  nextBurnAt: number | null;
  burns: Burn[];
  /** true while the list of burns is still being read from the chain */
  burnsLoading: boolean;
  asOf: number;
}

const POT = parseAbi([
  "function burnCount() view returns (uint256)",
  "function totalEthBurned() view returns (uint256)",
  "function totalTokensBurned() view returns (uint256)",
  "function lastBurnAt() view returns (uint256)",
  "function preview() view returns (uint256 amount, uint256 nextAt, bool ready, uint256 tokens)",
]);
const TOKEN = parseAbi(["function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);
// Tokens sent here can never move again; the token's burn() for holders sends them here, so they count as burned.
const DEAD = "0x000000000000000000000000000000000000dEaD" as Address;
const BURNED = parseAbiItem("event Burned(uint256 indexed n, address indexed caller, uint256 ethIn, uint256 tokensBurned, bool viaCurve)");
const LOG_SPAN = 9_000n; // the chain's RPC caps how many blocks one log query may cover

let cache: { at: number; state: TokenState } | null = null;
let refreshing: Promise<TokenState> | null = null;
let scanning: Promise<void> | null = null;
// Burns never change once mined, so each block range is read once, newest first: the blocks since the last look
// (up to hi), then further back (from lo down) until every burn the pot counts is listed, or the newest KEEP are.
// Progress is kept after every step, so a slow or failing chain node never sends the scan back to the start.
const scan = { hi: -1n, lo: -1n, burns: [] as Burn[], done: false };
const blockTimes = new Map<bigint, number>();
let devBurn: Burn | null | undefined;
const FRESH_MS = 60_000;
const FIRST_WAIT_MS = 4_000;
const KEEP = 50;

const withBurns = (state: TokenState): TokenState => ({
  ...state,
  burns: devBurn ? [...scan.burns, devBurn] : [...scan.burns],
  burnsLoading: !scan.done,
});

/**
 * The token's numbers and its burns. Visitors never wait on the chain's history: the numbers are a handful of
 * contract reads, and the list of burns is read behind them and shows as it arrives. A fresh reading (under a
 * minute old) is served as is, an older one is served at once while a single refresh runs behind it.
 */
export async function readToken(c: TokenConfig = tokenConfig()): Promise<TokenState | null> {
  if (!tokenLive(c)) return null;
  if (cache && Date.now() - cache.at < FRESH_MS) return withBurns(cache.state);
  const run = refreshing ?? (refreshing = refresh(c).finally(() => { refreshing = null; }));
  run.catch(() => {}); // a failed refresh keeps the last reading; the next visitor tries again
  if (cache) return withBurns(cache.state);
  // The first read after a start waits a few seconds at most.
  const first = await Promise.race([run.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), FIRST_WAIT_MS))]);
  return first ? withBurns(first) : null;
}

const clientFor = (c: TokenConfig) => createPublicClient({ transport: http(c.rpc, { timeout: 15_000 }) });

async function refresh(c: TokenConfig): Promise<TokenState> {
  const client = clientFor(c);
  const pot = c.pot!, token = c.token!;
  const [count, ethBurned, tokensBurned, last, preview, supply, potWei, deadWei] = await Promise.all([
    client.readContract({ address: pot, abi: POT, functionName: "burnCount" }),
    client.readContract({ address: pot, abi: POT, functionName: "totalEthBurned" }),
    client.readContract({ address: pot, abi: POT, functionName: "totalTokensBurned" }),
    client.readContract({ address: pot, abi: POT, functionName: "lastBurnAt" }),
    client.readContract({ address: pot, abi: POT, functionName: "preview" }).catch(() => null),
    client.readContract({ address: token, abi: TOKEN, functionName: "totalSupply" }),
    client.getBalance({ address: pot }),
    client.readContract({ address: token, abi: TOKEN, functionName: "balanceOf", args: [DEAD] }),
  ]);
  // the dev wallet's own burn: read once from its transaction, one row at the end (it came first)
  if (c.devBurnTx && devBurn === undefined) {
    const r = await client.getTransactionReceipt({ hash: c.devBurnTx }).catch(() => null);
    const log = r?.logs.find((l) => l.address.toLowerCase() === token.toLowerCase() && l.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" && l.topics[2] && BigInt(l.topics[2]) === BigInt(DEAD));
    if (r && log) {
      const at = Number((await client.getBlock({ blockNumber: r.blockNumber })).timestamp) * 1000;
      devBurn = { n: 0, at, eth: 0, tokens: Number(formatEther(BigInt(log.data))), tx: c.devBurnTx, dev: true };
    } else if (r) devBurn = null; // read, and not a burn of this token: do not ask again
  }
  const state: TokenState = {
    supplyLeft: Number(formatEther(supply - deadWei)),
    burnedTokens: Number(formatEther(tokensBurned + deadWei)),
    burnCount: Number(count),
    ethSpent: Number(formatEther(ethBurned)),
    potEth: Number(formatEther(potWei)),
    lastBurnAt: last > 0n ? Number(last) * 1000 : null,
    nextBurnAt: preview && preview[1] > 0n ? Number(preview[1]) * 1000 : null,
    burns: [],
    burnsLoading: true,
    asOf: Date.now(),
  };
  cache = { at: Date.now(), state };
  if (!scanning) {
    scanning = scanBurns(c, Number(count))
      .catch((err) => console.warn(`[sigil] token burns: ${(err as Error).message}`))
      .finally(() => { scanning = null; });
  }
  return state;
}

/** The pot's burns between two blocks, in spans the RPC accepts, four spans at a time, newest first. */
async function burnsBetween(client: ReturnType<typeof clientFor>, pot: Address, from: bigint, to: bigint): Promise<Burn[]> {
  const spans: [bigint, bigint][] = [];
  for (let f = from; f <= to; f += LOG_SPAN) spans.push([f, f + LOG_SPAN - 1n < to ? f + LOG_SPAN - 1n : to]);
  const logs = [];
  for (let i = 0; i < spans.length; i += 4) {
    const batch = await Promise.all(spans.slice(i, i + 4).map(([fromBlock, toBlock]) => client.getLogs({ address: pot, event: BURNED, fromBlock, toBlock })));
    logs.push(...batch.flat());
  }
  const missing = [...new Set(logs.map((l) => l.blockNumber))].filter((b) => !blockTimes.has(b));
  const blocks = await Promise.all(missing.map((blockNumber) => client.getBlock({ blockNumber })));
  blocks.forEach((b) => blockTimes.set(b.number, Number(b.timestamp) * 1000));
  return logs.map((l) => ({ n: Number(l.args.n), at: blockTimes.get(l.blockNumber)!, eth: Number(formatEther(l.args.ethIn ?? 0n)), tokens: Number(formatEther(l.args.tokensBurned ?? 0n)), tx: l.transactionHash }));
}

const merge = (a: Burn[], b: Burn[]) => [...new Map([...a, ...b].map((x) => [x.n, x])).values()].sort((x, y) => y.n - x.n).slice(0, KEEP);

async function scanBurns(c: TokenConfig, count: number): Promise<void> {
  const client = clientFor(c);
  const pot = c.pot!;
  const head = await client.getBlockNumber();
  if (scan.hi < 0n) {
    scan.hi = head;
    scan.lo = head + 1n;
  } else if (head > scan.hi) {
    scan.burns = merge(await burnsBetween(client, pot, scan.hi + 1n, head), scan.burns);
    scan.hi = head;
  }
  const step = LOG_SPAN * 4n;
  while (!scan.done) {
    if (scan.lo <= c.fromBlock || scan.burns.length >= Math.min(KEEP, count)) {
      scan.done = true;
      break;
    }
    const to = scan.lo - 1n;
    const from = to - step + 1n > c.fromBlock ? to - step + 1n : c.fromBlock;
    scan.burns = merge(scan.burns, await burnsBetween(client, pot, from, to));
    scan.lo = from;
  }
}
