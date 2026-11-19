// Publishing seal roots to the SigilSeal contract. OFF by default: nothing here
// runs unless SIGIL_ANCHOR=on and the contract address, an RPC URL and the
// sealer key are all set. While it is off, the site labels every seal "local".

import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Db } from "./db";
import { serverConfig } from "./config";
import { markAnchored, unanchoredSeals } from "./seal";

const ABI = parseAbi(["function sealMany(uint64[] hours_, bytes32[] roots, uint32[] leaves)"]);

export type AnchorStatus = { mode: "local"; reason: string } | { mode: "anchored"; contract: string };

export function anchorStatus(): AnchorStatus {
  if (!serverConfig.anchorEnabled) return { mode: "local", reason: "Anchoring is switched off." };
  const { rpcUrl, contract, sealerKey } = serverConfig.anchor;
  if (!rpcUrl || !/^0x[0-9a-fA-F]{40}$/.test(contract) || !/^0x[0-9a-fA-F]{64}$/.test(sealerKey)) {
    return { mode: "local", reason: "Anchoring is switched on but not fully configured." };
  }
  if (serverConfig.sealSeconds !== 3600) return { mode: "local", reason: "Anchoring needs one-hour seals." };
  return { mode: "anchored", contract };
}

let running = false;

/** Sends unpublished seals to the contract in one transaction. Returns the transaction hash, or null when there was nothing to do. */
export async function anchorPending(db: Db): Promise<string | null> {
  const status = anchorStatus();
  if (status.mode !== "anchored" || running) return null;
  const seals = unanchoredSeals(db);
  if (seals.length === 0) return null;
  running = true;
  try {
    const { rpcUrl, sealerKey } = serverConfig.anchor;
    const transport = http(rpcUrl);
    const probe = createPublicClient({ transport });
    const chainId = await probe.getChainId();
    const chain = defineChain({ id: chainId, name: "anchor", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
    const account = privateKeyToAccount(sealerKey as Hex);
    const wallet = createWalletClient({ account, chain, transport });
    const publicClient = createPublicClient({ chain, transport });
    const hash = await wallet.writeContract({
      address: status.contract as Hex,
      abi: ABI,
      functionName: "sealMany",
      args: [seals.map((s) => BigInt(s.hour)), seals.map((s) => s.root as Hex), seals.map((s) => s.leaves)],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Anchor transaction failed: ${hash}`);
    markAnchored(db, seals.map((s) => s.hour), hash);
    return hash;
  } finally {
    running = false;
  }
}
