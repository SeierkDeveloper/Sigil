// Where a life certificate's roots are checked: the seals this site publishes,
// and, when the seals are anchored, the SigilSeal contract itself, read from
// the visitor's own browser through a public read-only address.

import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import type { RootSource } from "@sigil/core";

const ABI = parseAbi(["function sealOf(uint64 hour) view returns ((bytes32 root, uint32 leaves, uint64 sealedAt))"]);
const ZERO = "0x" + "00".repeat(32);

/** The roots this site publishes, asked for in batches. */
export function siteRoots(base = ""): RootSource {
  return async (hours) => {
    const out = new Map<number, string>();
    for (let i = 0; i < hours.length; i += 5000) {
      const res = await fetch(`${base}/api/seals/roots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hours: hours.slice(i, i + 5000) }) });
      if (!res.ok) throw new Error(`the site answered ${res.status}`);
      const r = (await res.json()) as { roots: Record<string, string> };
      for (const [h, root] of Object.entries(r.roots)) out.set(Number(h), root);
    }
    return out;
  };
}

export interface ChainInfo {
  contract: string;
  rpcUrl: string;
}

/** The roots on chain: one eth_call to sealOf per hour, sent as JSON-RPC batches of 100. */
export function chainRoots(chain: ChainInfo): RootSource {
  return async (hours) => {
    const out = new Map<number, string>();
    for (let i = 0; i < hours.length; i += 100) {
      const part = hours.slice(i, i + 100);
      const body = part.map((h, j) => ({
        jsonrpc: "2.0",
        id: j,
        method: "eth_call",
        params: [{ to: chain.contract, data: encodeFunctionData({ abi: ABI, functionName: "sealOf", args: [BigInt(h)] }) }, "latest"],
      }));
      const res = await fetch(chain.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`the chain address answered ${res.status}`);
      const answers = (await res.json()) as { id: number; result?: Hex; error?: { message: string } }[];
      for (const a of answers) {
        if (!a.result) continue;
        const seal = decodeFunctionResult({ abi: ABI, functionName: "sealOf", data: a.result }) as { root: Hex };
        if (seal.root && seal.root !== ZERO) out.set(part[a.id], seal.root);
      }
    }
    return out;
  };
}
