import { describe, expect, it } from "vitest";
import { encodeFunctionData, hashMessage, hashTypedData, keccak256, parseAbi, recoverMessageAddress, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  checkCall,
  checksumAddress,
  cleanWalletRules,
  decodeSpendLog,
  EXECUTED_TOPIC,
  executeDigest,
  formatUnits,
  functionSelector,
  parseIdentityStatement,
  parseUnits,
  personalMessageHash,
  recoverDigest,
  registerDigest,
  selfIdentityKey,
  signDigest,
  signIdentity,
  toHex,
  vaultSigningKey,
  verifyIdentityStatement,
  walletConfig,
  walletRulesHash,
  type WalletRules,
} from "../src";

const VAULT = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const OTHER = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const hex = (b: Uint8Array) => `0x${toHex(b)}` as `0x${string}`;
const REGISTRY = "0x00000000000000000000000000000000005e1f01";
const WALLET = "0x00000000000000000000000000000000005e1f02";
const FRIEND = "0x1111111111111111111111111111111111111111";
const SHOP = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";

const rules: WalletRules = {
  perTx: "0.5",
  perDay: "1.25",
  expiresAt: "2030-01-01T00:00:00.000Z",
  recipients: [{ address: FRIEND, label: "A friend" }],
  contracts: [{ address: SHOP, label: "A shop", functions: ["order(uint256)"] }],
  tokens: [{ address: TOKEN, label: "Dollar", decimals: 6, perTx: "100", perDay: "250" }],
};

describe("the self key", () => {
  it("is derived from the vault key, the same every time, and differs per vault", async () => {
    const a = await selfIdentityKey(VAULT);
    const b = await selfIdentityKey(VAULT);
    const c = await selfIdentityKey(OTHER);
    expect(a.address).toBe(b.address);
    expect(a.address).not.toBe(c.address);
    expect(privateKeyToAccount(hex(a.secret)).address).toBe(a.address);
  });

  it("signs digests the way wallets do, with a low s, and recovers its address", async () => {
    const key = await selfIdentityKey(VAULT);
    const digest = personalMessageHash("hello");
    expect(hex(digest)).toBe(hashMessage("hello"));
    const sig = signDigest(key.secret, digest);
    expect(sig).toBe(await privateKeyToAccount(hex(key.secret)).signMessage({ message: "hello" }));
    expect(recoverDigest(digest, sig)).toBe(key.address);
    expect(await recoverMessageAddress({ message: "hello", signature: sig as `0x${string}` })).toBe(key.address);
    expect(recoverDigest(digest, "0x1234")).toBeNull();
  });

  it("writes addresses with their EIP-55 checksum", () => {
    expect(checksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    expect(() => checksumAddress("0x12")).toThrow();
  });
});

describe("EIP-712, as the contracts compute it", () => {
  it("matches viem's typed data hash for SigilSelfRegistry.register", async () => {
    const key = await selfIdentityKey(VAULT);
    const owner = "0x000000000000000000000000000000000000dEaD";
    const digest = registerDigest({ chainId: 8453n, registry: REGISTRY, owner, selfKey: key.address, metadataURI: "https://example.org/api/identity/x", deadline: 1_900_000_000n });
    const viemDigest = hashTypedData({
      domain: { name: "SigilSelfRegistry", version: "1", chainId: 8453, verifyingContract: REGISTRY },
      types: { Register: [{ name: "owner", type: "address" }, { name: "selfKey", type: "address" }, { name: "metadataURI", type: "string" }, { name: "deadline", type: "uint256" }] },
      primaryType: "Register",
      message: { owner, selfKey: key.address as `0x${string}`, metadataURI: "https://example.org/api/identity/x", deadline: 1_900_000_000n },
    });
    expect(hex(digest)).toBe(viemDigest);
  });

  it("matches viem's typed data hash for SigilSelfWallet.execute, and signs it", async () => {
    const key = await selfIdentityKey(VAULT);
    const data = encodeFunctionData({ abi: parseAbi(["function order(uint256)"]), args: [3n] });
    const digest = executeDigest({ chainId: 1n, wallet: WALLET, target: SHOP, value: 5n, data, nonce: 7n, deadline: 99n, gas: 150_000n });
    const viemDigest = hashTypedData({
      domain: { name: "SigilSelfWallet", version: "2", chainId: 1, verifyingContract: WALLET },
      types: {
        Execute: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "gas", type: "uint256" },
        ],
      },
      primaryType: "Execute",
      message: { target: SHOP, value: 5n, data, nonce: 7n, deadline: 99n, gas: 150_000n },
    });
    expect(hex(digest)).toBe(viemDigest);
    // The signed gas is part of what the self key agrees to.
    expect(hex(executeDigest({ chainId: 1n, wallet: WALLET, target: SHOP, value: 5n, data, nonce: 7n, deadline: 99n, gas: 0n }))).not.toBe(viemDigest);
    expect(recoverDigest(digest, signDigest(key.secret, digest))).toBe(key.address);
  });
});

describe("amounts and selectors", () => {
  it("parses and prints decimals exactly", () => {
    expect(parseUnits("1.5")).toBe(1_500_000_000_000_000_000n);
    expect(parseUnits("0.000001", 6)).toBe(1n);
    expect(formatUnits(1_250_000_000_000_000_000n)).toBe("1.25");
    expect(() => parseUnits("1e5")).toThrow();
    expect(() => parseUnits("-1")).toThrow();
    expect(() => parseUnits("0.0000001", 6)).toThrow();
  });

  it("computes selectors like the chain does", () => {
    expect(functionSelector("transfer(address,uint256)")).toBe("0xa9059cbb");
    expect(functionSelector("order( uint256 )")).toBe(toFunctionSelector("function order(uint256)"));
    expect(() => functionSelector("drop table")).toThrow();
  });
});

describe("wallet rules", () => {
  it("are cleaned, with checksummed addresses, and refuse what the wallet would not take", () => {
    const c = cleanWalletRules(rules);
    expect(c.recipients[0].address).toBe(checksumAddress(FRIEND));
    expect(c.perTx).toBe("0.5");
    expect(() => cleanWalletRules({ ...rules, perTx: "2" })).toThrow(/above the cap per day/);
    expect(() => cleanWalletRules({ ...rules, recipients: [{ address: "0x00000000000000000000000000000000000000", label: "" }] })).toThrow();
    expect(() => cleanWalletRules({ ...rules, recipients: [...rules.recipients, { address: FRIEND, label: "Twice" }] })).toThrow(/twice/);
    expect(() => cleanWalletRules({ ...rules, contracts: [{ address: SHOP, label: "", functions: ["not a function"] }] })).toThrow();
  });

  it("never guess a token's decimals (HeyResearch security review, M-1)", () => {
    const { decimals: _gone, ...noDecimals } = rules.tokens[0];
    expect(() => cleanWalletRules({ ...rules, tokens: [noDecimals as never] })).toThrow(/decimals were not read from the chain/);
    expect(() => cleanWalletRules({ ...rules, tokens: [{ ...rules.tokens[0], decimals: Number.NaN }] })).toThrow(/decimals/);
    expect(() => cleanWalletRules({ ...rules, tokens: [{ ...rules.tokens[0], decimals: 37 }] })).toThrow(/decimals/);
    // The same "50" is 50e6 base units for a 6-decimal token: what the wallet holds is what the vault checks.
    const six = walletConfig({ ...rules, tokens: [{ ...rules.tokens[0], perTx: "50", perDay: "50" }] }).tokens[0];
    expect([six.perTx, six.perDay]).toEqual([50_000_000n, 50_000_000n]);
    const call = { target: TOKEN, value: "0", fn: "transfer(address,uint256)", to: FRIEND, amount: "60" };
    expect(checkCall({ ...rules, tokens: [{ ...rules.tokens[0], perTx: "50", perDay: "50" }] }, call, undefined, { now: Date.parse("2029-06-01") })).toMatchObject({ reason: "Over the token's cap per transaction." });
  });

  it("keep recipients and contracts apart (HeyResearch security review, L-1)", () => {
    // An address is a recipient or a contract, never both, and a token is never a recipient.
    expect(() => cleanWalletRules({ ...rules, recipients: [...rules.recipients, { address: SHOP, label: "Shop" }] })).toThrow(/never both/);
    expect(() => cleanWalletRules({ ...rules, recipients: [...rules.recipients, { address: TOKEN, label: "Token" }] })).toThrow(/never both/);
    const at = { now: Date.parse("2029-06-01") };
    // A token goes only to a recipient: never to a listed contract or to a token contract.
    expect(checkCall(rules, { target: TOKEN, value: "0", fn: "transfer(address,uint256)", to: SHOP, amount: "1" }, undefined, at)).toMatchObject({ reason: "The recipient is not one of the recipients." });
    expect(checkCall(rules, { target: TOKEN, value: "0", fn: "transfer(address,uint256)", to: TOKEN, amount: "1" }, undefined, at)).toMatchObject({ reason: "The recipient is not one of the recipients." });
    expect(checkCall(rules, { target: TOKEN, value: "0", fn: "approve(address,uint256)", to: SHOP, amount: "1" }, undefined, at)).toMatchObject({ reason: "The recipient is not one of the recipients." });
    expect(checkCall(rules, { target: TOKEN, value: "0", fn: "approve(address,uint256)", to: FRIEND, amount: "1" }, undefined, at)).toEqual({ ok: true });
    // A plain payment (no function) goes only to a recipient, never to a contract's receive or fallback.
    expect(checkCall(rules, { target: SHOP, value: "0.1", fn: "" }, undefined, at)).toMatchObject({ reason: "This address is not one of the recipients." });
    expect(checkCall(rules, { target: SHOP, value: "0", fn: "" }, undefined, at)).toMatchObject({ reason: "This address is not one of the recipients." });
    // And a recipient is never called with a function.
    expect(checkCall(rules, { target: FRIEND, value: "0", fn: "order(uint256)" }, undefined, at)).toMatchObject({ reason: "This contract is not on the list of contracts." });
  });

  it("give the exact arguments of configure()", () => {
    const cfg = walletConfig(rules);
    expect(cfg.perTxCap).toBe(500_000_000_000_000_000n);
    expect(cfg.perDayCap).toBe(1_250_000_000_000_000_000n);
    expect(cfg.expiresAt).toBe(1_893_456_000n);
    expect(cfg.recipients.map((t) => t.toLowerCase())).toEqual([FRIEND]);
    expect(cfg.targets.map((t) => t.toLowerCase())).toEqual([SHOP, TOKEN]);
    expect(cfg.selectors).toContainEqual({ target: checksumAddress(SHOP), selector: functionSelector("order(uint256)") });
    expect(cfg.selectors).toContainEqual({ target: checksumAddress(TOKEN), selector: "0xa9059cbb" });
    expect(cfg.tokens).toEqual([{ token: checksumAddress(TOKEN), perTx: 100_000_000n, perDay: 250_000_000n }]);
  });

  it("have a stable fingerprint that changes with any rule", () => {
    expect(walletRulesHash(rules)).toBe(walletRulesHash(JSON.parse(JSON.stringify(rules))));
    expect(walletRulesHash({ ...rules, perDay: "1.26" })).not.toBe(walletRulesHash(rules));
  });

  it("are checked off chain in the same order as the contract", () => {
    const at = Date.parse("2029-06-01T00:00:00Z");
    const ok = (call: Parameters<typeof checkCall>[1], spent?: Parameters<typeof checkCall>[2], opts?: Parameters<typeof checkCall>[3]) => checkCall(rules, call, spent, { now: at, ...opts });
    expect(ok({ target: FRIEND, value: "0.5", fn: "" })).toEqual({ ok: true });
    expect(ok({ target: FRIEND, value: "0.6", fn: "" })).toMatchObject({ ok: false, reason: "Over the cap per transaction." });
    expect(ok({ target: FRIEND, value: "0.5", fn: "" }, { native: parseUnits("1"), tokens: {} })).toMatchObject({ reason: "Over the cap per day." });
    expect(ok({ target: SHOP, value: "0", fn: "order(uint256)" })).toEqual({ ok: true });
    expect(ok({ target: SHOP, value: "0", fn: "cancel()" })).toMatchObject({ reason: "That function is not allowed on this contract." });
    expect(ok({ target: "0x4444444444444444444444444444444444444444", value: "0", fn: "" })).toMatchObject({ reason: "This address is not one of the recipients." });
    expect(ok({ target: "0x4444444444444444444444444444444444444444", value: "0", fn: "order(uint256)" })).toMatchObject({ reason: "This contract is not on the list of contracts." });
    expect(ok({ target: TOKEN, value: "0", fn: "transfer(address,uint256)", to: FRIEND, amount: "100" })).toEqual({ ok: true });
    expect(ok({ target: TOKEN, value: "0", fn: "transfer(address,uint256)", to: FRIEND, amount: "101" })).toMatchObject({ reason: "Over the token's cap per transaction." });
    expect(ok({ target: TOKEN, value: "0", fn: "transfer(address,uint256)", to: "0x4444444444444444444444444444444444444444", amount: "1" })).toMatchObject({ reason: "The recipient is not one of the recipients." });
    expect(ok({ target: FRIEND, value: "0.1", fn: "" }, undefined, { frozen: true })).toMatchObject({ reason: "The wallet is frozen." });
    expect(checkCall(rules, { target: FRIEND, value: "0.1", fn: "" }, undefined, { now: Date.parse("2031-01-01") })).toMatchObject({ reason: "The rules have expired." });
  });
});

describe("spends", () => {
  it("are read from the wallet's Executed events", () => {
    expect(EXECUTED_TOPIC).toBe(keccak256(new TextEncoder().encode("Executed(uint256,address,uint256,bytes4,address,uint256)")));
    const word = (n: bigint) => n.toString(16).padStart(64, "0");
    const log = {
      topics: [EXECUTED_TOPIC, `0x${word(4n)}`, `0x${"0".repeat(24)}${TOKEN.slice(2)}`],
      data: `0x${word(0n)}${"a9059cbb".padEnd(64, "0")}${"0".repeat(24)}${FRIEND.slice(2)}${word(25n)}`,
      blockNumber: "0x10",
      transactionHash: "0xabc",
    };
    expect(decodeSpendLog(log)).toEqual({ nonce: 4, target: checksumAddress(TOKEN), value: 0n, selector: "0xa9059cbb", tokenTo: checksumAddress(FRIEND), tokenAmount: 25n, block: 16, tx: "0xabc" });
    expect(decodeSpendLog({ ...log, topics: ["0x00", ...log.topics.slice(1)] })).toBeNull();
  });
});

describe("the identity statement", () => {
  it("is signed by the vault key and the self key, and checks in full", async () => {
    const signing = await vaultSigningKey(VAULT);
    const self = await selfIdentityKey(VAULT);
    const st = signIdentity(signing, self, { name: "Sam's AI self", about: "Answers questions about my work.", owner: null, wallet: null, chain: null, origin: "https://sigil.example", issuedAt: "2026-11-20T10:00:00.000Z" });
    expect(st.body.selfKey).toBe(self.address);
    expect(st.body.signingKey).toBe(signing.publicKey);
    expect(verifyIdentityStatement(parseIdentityStatement(JSON.stringify(st)))).toMatchObject({ ok: true });
  });

  it("fails when either key is swapped or the body is changed", async () => {
    const signing = await vaultSigningKey(VAULT);
    const self = await selfIdentityKey(VAULT);
    const other = await selfIdentityKey(OTHER);
    const st = signIdentity(signing, self, { name: "Sam", about: "", owner: null, wallet: null, chain: null, origin: "https://sigil.example", issuedAt: "2026-11-20T10:00:00.000Z" });
    const changed = { ...st, body: { ...st.body, name: "Someone else" } };
    expect(verifyIdentityStatement(changed).ok).toBe(false);
    const wrongSelf = { ...st, body: { ...st.body, selfKey: other.address } };
    const r = verifyIdentityStatement(wrongSelf);
    expect(r.checks.map((c) => c.ok)).toEqual([false, false]);
    expect(() => parseIdentityStatement("{}")).toThrow(/not a Sigil identity statement/);
  });
});
