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
    const [perTx, perDay, expires, targets, selectors] = call.args as [bigint, bigint, bigint, string[], { target: string; selector: string }[]];
    expect([perTx, perDay, expires]).toEqual([50_000_000_000_000_000n, 200_000_000_000_000_000n, 1_811_808_000n]);
    expect(targets.map((t) => t.toLowerCase())).toEqual(["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"]);
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
    expect((call.args as unknown[])[0]).toBe((await selfIdentityKey(o.vault.raw)).address);
    expect(id.freezeCalldata()).toBe(toFunctionSelector("function freeze()"));
  });

  it("read the wallet and its spends through the public read address, with no key", async () => {
    const wallet = "0x00000000000000000000000000000000005e1f02";
    const seen: unknown[] = [];
    const fetcher = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seen.push(body);
      if (Array.isArray(body)) {
        const values: Record<string, unknown> = { owner: "0x000000000000000000000000000000000000dEaD", selfKey: "0x000000000000000000000000000000000000bEEF", frozen: false, perTxCap: 5n, perDayCap: 9n, expiresAt: 0n, remainingToday: 4n };
        return new Response(
          JSON.stringify(
            body.map((c: { id: number; params: [{ data: Hex }] }) => {
              if (c.id === 99) return { id: 99, result: "0x64" };
              const fn = decodeFunctionData({ abi: id.WALLET_ABI, data: c.params[0].data }).functionName;
              return { id: c.id, result: encodeFunctionResult({ abi: id.WALLET_ABI, functionName: fn, result: values[fn] as never }) };
            }),
          ),
        );
      }
      const w = (n: bigint) => n.toString(16).padStart(64, "0");
      return new Response(
        JSON.stringify({
          result: [{ topics: [EXECUTED_TOPIC, `0x${w(0n)}`, `0x${w(0x1111n)}`], data: `0x${w(5n)}${"0".repeat(64)}${"0".repeat(64)}${w(0n)}`, blockNumber: "0x60", transactionHash: "0xab" }],
        }),
      );
    };
    const state = await id.readWallet({ chainId: "1", registry: wallet, rpcUrl: "https://rpc.example.org" }, wallet, fetcher);
    expect(state).toMatchObject({ frozen: false, perTxCap: 5n, perDayCap: 9n, remainingToday: 4n });
    expect(state.spends).toEqual([expect.objectContaining({ nonce: 0, value: 5n, selector: null })]);
    expect(JSON.stringify(seen)).not.toMatch(/private|secret|sign/i);
  });
});
