// Where a certificate's roots are compared: the site's published seals, and
// SigilSeal on chain. The chain is played here by a JSON-RPC answerer that
// decodes each eth_call with the contract's ABI and answers with real encoding.

import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from "viem";
import { chainRoots, siteRoots } from "../src/lib/roots";

const ABI = parseAbi(["function sealOf(uint64 hour) view returns ((bytes32 root, uint32 leaves, uint64 sealedAt))"]);
const ROOT = ("0x" + "ab".repeat(32)) as Hex;
const ZERO = ("0x" + "00".repeat(32)) as Hex;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("roots on chain", () => {
  it("asks sealOf for each hour in batches and leaves out hours with no seal", async () => {
    const calls: { to: string; hour: bigint }[][] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(url).toBe("https://rpc.example.org");
      const batch = JSON.parse(String(init.body)) as { id: number; method: string; params: [{ to: string; data: Hex }, string] }[];
      calls.push(
        batch.map((b) => {
          expect(b.method).toBe("eth_call");
          const { args } = decodeFunctionData({ abi: ABI, data: b.params[0].data });
          return { to: b.params[0].to, hour: args[0] as bigint };
        }),
      );
      return new Response(
        JSON.stringify(
          batch.map((b) => {
            const hour = Number((decodeFunctionData({ abi: ABI, data: b.params[0].data }).args[0] as bigint));
            const sealed = hour % 2 === 0;
            return { jsonrpc: "2.0", id: b.id, result: encodeFunctionResult({ abi: ABI, functionName: "sealOf", result: { root: sealed ? ROOT : ZERO, leaves: sealed ? 3 : 0, sealedAt: 1n } }) };
          }),
        ),
      );
    });
    const hours = Array.from({ length: 150 }, (_, i) => 490_000 + i);
    const roots = await chainRoots({ contract: "0x" + "12".repeat(20), rpcUrl: "https://rpc.example.org" })(hours);
    expect(calls.map((c) => c.length)).toEqual([100, 50]);
    expect(calls[0][0]).toEqual({ to: "0x" + "12".repeat(20), hour: 490_000n });
    expect(roots.size).toBe(75);
    expect(roots.get(490_000)).toBe(ROOT);
    expect(roots.has(490_001)).toBe(false);
  });

  it("reports an address that does not answer", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 502 }));
    await expect(chainRoots({ contract: "0x" + "12".repeat(20), rpcUrl: "https://rpc.example.org" })([1])).rejects.toThrow("502");
  });
});

describe("roots this site publishes", () => {
  it("asks in batches of 5,000 and returns them by hour", async () => {
    const sizes: number[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/seals/roots");
      const { hours } = JSON.parse(String(init.body)) as { hours: number[] };
      sizes.push(hours.length);
      return new Response(JSON.stringify({ roots: Object.fromEntries(hours.filter((h) => h % 10 === 0).map((h) => [String(h), ROOT])) }));
    });
    const roots = await siteRoots()(Array.from({ length: 6000 }, (_, i) => i));
    expect(sizes).toEqual([5000, 1000]);
    expect(roots.size).toBe(600);
  });
});
