// The AI self's identity: the self key derived on the device, a statement
// signed by both keys and served for the registry's metadata address, wallet
// rules kept encrypted, and the calls the owner's wallet would send. No chain
// is reached: the registry and the wallet are tested with Foundry.

import { beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, toFunctionSelector, type Hex } from "viem";
import { checksumAddress, EXECUTED_TOPIC, functionSelector, parseIdentityStatement, selfIdentityKey, verifyIdentityStatement, type WalletRules } from "@sigil/core";
import { count, dumpDb, harness, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as id from "../src/vault/identityOps";
import { serverConfig } from "../src/server/config";

let h: Harness;
beforeEach(() => {
  h = harness();
});

const ORIGIN = "http://localhost:3000";
const rules: WalletRules = {
  perTx: "0.05",
  perDay: "0.2",
  expiresAt: "2027-06-01T00:00:00.000Z",
  recipients: [{ address: "0x1111111111111111111111111111111111111111", label: "CANARY-friend" }],
  contracts: [{ address: "0x2222222222222222222222222222222222222222", label: "Shop", functions: ["order(uint256)"] }],
  tokens: [],
};

describe("the self key and its statement", () => {
  it("are made on the device; the server keeps the address and a statement it checked", async () => {
    const o = await signedUp(h);
    expect(o.data.identity).toBeNull();
    const view = await id.makeSelfKey(o.b.api, o.vault);
    expect(view.address).toBe((await selfIdentityKey(o.vault.raw)).address);
    // The same vault always makes the same key; asking again changes nothing.
    expect((await id.makeSelfKey(o.b.api, o.vault)).address).toBe(view.address);

    const choices = await id.saveChoices(o.b.api, o.vault, { name: "CANARY-name AI self", about: "CANARY-about", owner: "", wallet: "" });
    const signed = await id.signStatement(o.b.api, o.vault, choices, null, ORIGIN);
    expect(signed.statement?.body).toMatchObject({ selfKey: view.address, name: "CANARY-name AI self", chain: null });

    // Anyone can read it at the metadata address and check both signatures.
    const res = await h.raw("GET", `identity/at/${view.address}`);
    expect(res.status).toBe(200);
    expect(verifyIdentityStatement(parseIdentityStatement(await res.text())).ok).toBe(true);
    expect(id.metadataUrl(ORIGIN, view.address)).toBe(`${ORIGIN}/api/identity/at/${view.address}`);

    const data = await ops.loadVault(o.b.api, o.vault);
    expect(data.identity?.statement?.body.name).toBe("CANARY-name AI self");
    expect(data.identityChoices.about).toBe("CANARY-about");
    // The choices are an encrypted setting; the statement is public by the owner's choice.
    expect(dumpDb(h.db).match(/CANARY-about/g)?.length).toBe(1);

    const steps = (await ops.loadLog(o.b.api)).entries.filter((e) => e.kind === "identity").map((e) => e.memoryId);
    expect(steps).toEqual(expect.arrayContaining(["key-made", "statement-signed"]));

    await id.withdrawStatement(o.b.api);
    expect((await h.raw("GET", `identity/at/${view.address}`)).status).toBe(404);
  });

  it("refuses a statement for another key, from another vault, or changed after signing", async () => {
    const a = await signedUp(h);
    const b = await signedUp(h);
    await id.makeSelfKey(a.b.api, a.vault);
    await id.makeSelfKey(b.b.api, b.vault);
    const signed = await id.signStatement(b.b.api, b.vault, id.EMPTY_CHOICES, null, ORIGIN);
    await expect(a.b.api.put("self/identity/statement", { statement: JSON.stringify(signed.statement) })).rejects.toMatchObject({ status: 400 });
    const changed = { ...signed.statement!, body: { ...signed.statement!.body, name: "Someone else" } };
    await expect(b.b.api.put("self/identity/statement", { statement: JSON.stringify(changed) })).rejects.toMatchObject({ code: "bad_signature" });
    // One self key per vault, and never another vault's.
    await expect(a.b.api.post("self/identity", { address: signed.address })).rejects.toMatchObject({ status: 409 });
  });

  it("works with no registry configured, and says where the registry is once it is", async () => {
    expect(serverConfig.identityChain).toBeNull();
    expect(await (await h.raw("GET", "identity/config")).json()).toEqual({ chain: null });
    process.env.SIGIL_IDENTITY_CHAIN_ID = "8453";
    process.env.SIGIL_IDENTITY_REGISTRY = "0x00000000000000000000000000000000005e1f01";
    process.env.SIGIL_IDENTITY_READ_RPC = "https://rpc.example.org";
    try {
      expect(serverConfig.identityChain).toEqual({ chainId: "8453", registry: "0x00000000000000000000000000000000005e1f01", rpcUrl: "https://rpc.example.org" });
    } finally {
      delete process.env.SIGIL_IDENTITY_CHAIN_ID;
      delete process.env.SIGIL_IDENTITY_REGISTRY;
      delete process.env.SIGIL_IDENTITY_READ_RPC;
    }
  });
});

describe("wallet rules", () => {
  it("are saved encrypted, logged, and turned into the exact configure() call", async () => {
    const o = await signedUp(h);
    await id.saveRules(o.b.api, o.vault, rules);
    const data = await ops.loadVault(o.b.api, o.vault);
    expect(data.walletRules?.recipients[0]).toEqual({ address: checksumAddress(rules.recipients[0].address), label: "CANARY-friend" });
    expect(dumpDb(h.db)).not.toContain("CANARY-friend");
    expect(count(h.db, "SELECT COUNT(*) AS n FROM read_log WHERE kind = 'identity' AND memory_id = 'rules-saved'")).toBe(1);

    const call = decodeFunctionData({ abi: id.WALLET_ABI, data: id.configureCalldata(rules) });
    expect(call.functionName).toBe("configure");
    const [perTx, perDay, expires, recipients, targets, selectors] = call.args as unknown as [bigint, bigint, bigint, string[], string[], { target: string; selector: string }[]];
    expect([perTx, perDay, expires]).toEqual([50_000_000_000_000_000n, 200_000_000_000_000_000n, 1_811_808_000n]);
    // Recipients and contracts are two lists on chain (HeyResearch security review, L-1).
    expect(recipients.map((t) => t.toLowerCase())).toEqual(["0x1111111111111111111111111111111111111111"]);
    expect(targets.map((t) => t.toLowerCase())).toEqual(["0x2222222222222222222222222222222222222222"]);
    expect(selectors).toEqual([{ target: checksumAddress("0x2222222222222222222222222222222222222222"), selector: functionSelector("order(uint256)") }]);
  });

  it("refuses rules the wallet would not take", async () => {
    const o = await signedUp(h);
    await expect(id.saveRules(o.b.api, o.vault, { ...rules, perTx: "1" })).rejects.toThrow(/above the cap per day/);
  });
});

describe("the calls for the chain", () => {
  it("register with a signature by the self key for exactly this owner", async () => {
    const o = await signedUp(h);
    const chain = { chainId: "8453", registry: "0x00000000000000000000000000000000005e1f01", rpcUrl: "" };
    const data = await id.registerCalldata(o.vault, chain, "0x000000000000000000000000000000000000dEaD", "https://x.example/api/identity/at/x", 1_900_000_000n);
    const call = decodeFunctionData({ abi: id.REGISTRY_ABI, data });
    expect(call.functionName).toBe("register");
    expect((call.args as unknown as unknown[])[0]).toBe((await selfIdentityKey(o.vault.raw)).address);
    expect(id.freezeCalldata()).toBe(toFunctionSelector("function freeze()"));
  });

  it("read the wallet, its token caps, open allowances and today's spends through the public read address, with no key", async () => {
    const wallet = "0x00000000000000000000000000000000005e1f02";
    const token = "0x3333333333333333333333333333333333333333";
    const friend = "0x1111111111111111111111111111111111111111";
    const now = Date.parse("2026-11-26T12:00:00Z");
    const dayStart = Math.floor(now / 86_400_000) * 86_400;
    const latest = 1_000_000;
    const seen: unknown[] = [];
    const ranges: [number, number][] = [];
    const w = (n: bigint) => n.toString(16).padStart(64, "0");
    const fetcher = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seen.push(body);
      if (Array.isArray(body)) {
        const values: Record<string, unknown> = {
          owner: "0x000000000000000000000000000000000000dEaD",
          selfKey: "0x000000000000000000000000000000000000bEEF",
          frozen: false,
          perTxCap: 5n,
          perDayCap: 9n,
          expiresAt: 0n,
          remainingToday: 4n,
          openApprovals: [{ token, spender: friend }],
          tokenLimit: [50_000_000n, 50_000_000n],
          tokenRemainingToday: 20_000_000n,
        };
        return new Response(
          JSON.stringify(
            body.map((c: { id: number; params: [{ to: string; data: Hex }] }) => {
              if (c.params[0].to.toLowerCase() === token) return { id: c.id, result: encodeFunctionResult({ abi: id.ERC20_ABI, functionName: "allowance", result: 30_000_000n }) };
              const fn = decodeFunctionData({ abi: id.WALLET_ABI, data: c.params[0].data }).functionName;
              return { id: c.id, result: encodeFunctionResult({ abi: id.WALLET_ABI, functionName: fn, result: values[fn] as never }) };
            }),
          ),
        );
      }
      if (body.method === "eth_blockNumber") return new Response(JSON.stringify({ result: `0x${latest.toString(16)}` }));
      if (body.method === "eth_getBlockByNumber") {
        // Ten blocks a second, block `latest` at `now`.
        if (body.params[0] === "latest") return new Response(JSON.stringify({ result: { number: `0x${latest.toString(16)}`, timestamp: `0x${Math.floor(now / 1000).toString(16)}` } }));
        const n = Number(BigInt(body.params[0]));
        return new Response(JSON.stringify({ result: { timestamp: `0x${(Math.floor(now / 1000) - Math.floor((latest - n) / 10)).toString(16)}` } }));
      }
      const from = Number(BigInt(body.params[0].fromBlock));
      const to = Number(BigInt(body.params[0].toBlock));
      ranges.push([from, to]);
      // The node refuses a span that holds too many logs: the reader halves it.
      if (to - from > 60_000) return new Response(JSON.stringify({ error: { message: "logs matched by query exceeds limit of 10000" } }));
      // One spend this morning, and one a block before 00:00 UTC that a span cut by block would catch.
      const beforeMidnight = latest - (Math.floor(now / 1000) - dayStart) * 10 - 10;
      const logAt = (b: number, nonce: bigint) => ({ topics: [EXECUTED_TOPIC, `0x${w(nonce)}`, `0x${w(0x1111n)}`], data: `0x${w(5n)}${"0".repeat(64)}${"0".repeat(64)}${w(0n)}`, blockNumber: `0x${b.toString(16)}`, transactionHash: "0xab" });
      return new Response(
        JSON.stringify({
          result: [logAt(beforeMidnight, 7n), logAt(latest - 5, 0n)].filter((l) => from <= Number(BigInt(l.blockNumber)) && Number(BigInt(l.blockNumber)) <= to),
        }),
      );
    };
    // No clock passed: the day comes from the chain's latest block (N-5).
    const state = await id.readWallet({ chainId: "1", registry: wallet, rpcUrl: "https://rpc.example.org" }, wallet, { tokens: [token], fetcher, pauseMs: 0 });
    expect(state).toMatchObject({ frozen: false, perTxCap: 5n, perDayCap: 9n, remainingToday: 4n });
    // The token caps as set on chain, read back (HeyResearch security review, M-1).
    expect(state.tokens).toEqual([{ token: checksumAddress(token), perTx: 50_000_000n, perDay: 50_000_000n, remainingToday: 20_000_000n }]);
    // The allowances the self key gave, and what each spender may still take (I-1).
    expect(state.approvals).toEqual([{ token: checksumAddress(token), spender: checksumAddress(friend), allowance: 30_000_000n }]);
    expect(state.spends).toEqual([expect.objectContaining({ nonce: 0, value: 5n, selector: null })]);
    // The spends go back to 00:00 UTC, twelve hours here: far past the old window of 50,000 blocks (I-3).
    expect(state.coversToday).toBe(true);
    expect(latest - state.spendsFromBlock).toBeGreaterThan(12 * 3600 * 10 - id.LOG_CHUNK);
    expect(state.spendsFromBlock).toBeLessThanOrEqual(latest - (Math.floor(now / 1000) - dayStart) * 10);
    // No query asked for more than one chunk of blocks.
    expect(Math.max(...ranges.map(([a, b]) => b - a + 1))).toBeLessThanOrEqual(id.LOG_CHUNK);
    expect(JSON.stringify(seen)).not.toMatch(/private|secret|sign/i);
  });

  it("cut the span that crosses 00:00 UTC with one bisection, however many spends the evening holds", async () => {
    const wallet = "0x00000000000000000000000000000000005e1f02";
    const latest = 1_000_000;
    const midnight = 1_800_000_000; // a 00:00 UTC
    // One block a second; block `latest` is 01:00 UTC, so 00:00 UTC is block latest - 3600.
    const timeOf = (b: number) => midnight + 3600 - (latest - b);
    const cut = latest - 3600;
    const w = (n: bigint) => n.toString(16).padStart(64, "0");
    // 400 spends in the hour before midnight, each in its own block, and 3 after it.
    const blocks = [...Array.from({ length: 400 }, (_, i) => cut - 1 - i * 9), cut, cut + 1, latest - 2];
    let blockReads = 0;
    const fetcher = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "eth_getBlockByNumber") {
        blockReads++;
        return new Response(JSON.stringify({ result: { timestamp: `0x${timeOf(Number(BigInt(body.params[0]))).toString(16)}` } }));
      }
      const from = Number(BigInt(body.params[0].fromBlock));
      const to = Number(BigInt(body.params[0].toBlock));
      const logs = blocks
        .filter((b) => from <= b && b <= to)
        .sort((a, b) => a - b)
        .map((b, i) => ({ topics: [EXECUTED_TOPIC, `0x${w(BigInt(i))}`, `0x${w(0x1111n)}`], data: `0x${w(5n)}${"0".repeat(64)}${"0".repeat(64)}${w(0n)}`, blockNumber: `0x${b.toString(16)}`, transactionHash: "0xab" }));
      return new Response(JSON.stringify({ result: logs }));
    };
    const page = await id.readSpends({ chainId: "1", registry: wallet, rpcUrl: "https://rpc.example.org" }, wallet, { toBlock: latest, untilTime: midnight, fetcher, pauseMs: 0 });
    expect(page.reached).toBe(true);
    expect(page.spends.map((s) => s.block).sort((a, b) => a - b)).toEqual([cut, cut + 1, latest - 2]);
    // One read for the span's first block, then a bisection over 100,000 blocks: never one read per spend.
    expect(blockReads).toBeLessThanOrEqual(1 + Math.ceil(Math.log2(id.LOG_CHUNK)) + 1);
  });

  it("read a token's decimals from the token, and refuse a token that does not answer (HeyResearch security review, M-1)", async () => {
    const chain = { chainId: "1", registry: "0x00000000000000000000000000000000005e1f01", rpcUrl: "https://rpc.example.org" };
    const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
    const answer = (decimals: number | null) => async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; params: [{ data: Hex }] }[];
      return new Response(
        JSON.stringify(
          body.map((c) => {
            const fn = decodeFunctionData({ abi: id.ERC20_ABI, data: c.params[0].data }).functionName;
            if (decimals === null) return { id: c.id, error: { message: "execution reverted" } };
            return { id: c.id, result: fn === "decimals" ? encodeFunctionResult({ abi: id.ERC20_ABI, functionName: "decimals", result: decimals }) : encodeFunctionResult({ abi: id.ERC20_ABI, functionName: "symbol", result: "USDG" }) };
          }),
        ),
      );
    };
    expect(await id.readToken(chain, usdg, answer(6))).toEqual({ address: checksumAddress(usdg), decimals: 6, symbol: "USDG" });
    await expect(id.readToken(chain, usdg, answer(null))).rejects.toThrow(/did not answer decimals\(\)/);
    await expect(id.readToken({ ...chain, rpcUrl: "" }, usdg, answer(6))).rejects.toThrow(/read address/);
    // A draft whose decimals differ from the token's is refused before it is kept or set on chain.
    const withToken: WalletRules = { ...rules, tokens: [{ address: usdg, label: "USDG", decimals: 18, perTx: "50", perDay: "50" }] };
    await expect(id.checkTokenDecimals(chain, withToken, answer(6))).rejects.toThrow(/6 decimals on chain, the draft says 18/);
    await expect(id.checkTokenDecimals(chain, { ...withToken, tokens: [{ ...withToken.tokens[0], decimals: 6 }] }, answer(6))).resolves.toBeUndefined();
    await expect(id.checkTokenDecimals(chain, { ...withToken, tokens: [{ ...withToken.tokens[0], decimals: 6 }] }, answer(null))).rejects.toThrow(/did not answer/);
  });

  it("sizes the gas of freeze and revoke to the open allowances, and refuses a contract as a recipient", async () => {
    const chain = { chainId: "1", registry: "0x00000000000000000000000000000000005e1f01", rpcUrl: "https://rpc.example.org" };
    // Enough for the wallet's own check (130,000 left before each allowance) at every count it can list.
    expect(id.revokeGasLimit(0)).toBe(180_000n);
    expect(id.revokeGasLimit(16)).toBe(180_000n + 16n * 150_000n);
    const person = "0x00000000000000000000000000000000000a11ce";
    const delegated = "0x00000000000000000000000000000000000b0b00";
    const contract = "0x00000000000000000000000000000000000c0de0";
    const codes: Record<string, string> = { [person]: "0x", [delegated]: `0xef0100${"12".repeat(20)}`, [contract]: "0x6080604052" };
    const answer = async (_u: string, init?: RequestInit) => {
      const calls = JSON.parse(String(init?.body)) as { id: number; params: [string] }[];
      return new Response(JSON.stringify(calls.map((c) => ({ id: c.id, result: codes[c.params[0].toLowerCase()] }))));
    };
    const withRecipients = (addrs: string[]): WalletRules => ({ ...rules, recipients: addrs.map((address, i) => ({ address, label: `R${i}` })) });
    await expect(id.checkRecipientsAreNotContracts(chain, withRecipients([person, delegated]), answer)).resolves.toBeUndefined();
    await expect(id.checkRecipientsAreNotContracts(chain, withRecipients([person, contract]), answer)).rejects.toThrow(/is a contract/);
  });
});
