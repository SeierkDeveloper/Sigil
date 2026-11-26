// The self wallet, live, end to end on a local test chain (anvil): the real
// SigilSelfRegistry and SigilSelfWallet, the owner's own browser wallet (a
// key held by this test, played through window.ethereum), and a 6-decimal
// token like USDG. The vault registers the self, deploys and links its
// wallet, funds it, reads a token's decimals from the token, sets the rules
// on chain and compares them, tries payments against the chain, pays within
// the owner's limits with receipts, holds a payment past them in Work, freezes
// and unfreezes, withdraws, and the receipts check on the verify page against
// the sealed root. Nothing reaches any real chain.

import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, parseEther, parseUnits, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { ANVIL_DEPLOYER, ANVIL_REGISTRY, ANVIL_RPC, CHAIN_URL } from "../playwright.config";
import { confirmPhrase, openTab, ROOT } from "./helpers";

const chain = { ...foundry, rpcUrls: { default: { http: [ANVIL_RPC] } } };
const pub = createPublicClient({ chain, transport: http(ANVIL_RPC) });
const artifact = (file: string, name: string) => JSON.parse(readFileSync(path.join(ROOT, "contracts/out", file, `${name}.json`), "utf8")) as { bytecode: { object: Hex }; deployedBytecode: { object: Hex } };
const FRIEND = "0x1111111111111111111111111111111111111111";
/** With SIGIL_SHOTS_DIR set, the run also saves screen-sized screenshots of each new screen there; SIGIL_SHOTS_PHONE=1 runs it at 390 by 844 as on a phone. */
const SHOTS = process.env.SIGIL_SHOTS_DIR;
const PHONE = process.env.SIGIL_SHOTS_PHONE === "1";

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(ANVIL_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

async function deployFromAnvil(code: Hex): Promise<string> {
  const hash = (await rpc("eth_sendTransaction", [{ from: ANVIL_DEPLOYER, data: code }])) as Hex;
  const r = await pub.waitForTransactionReceipt({ hash });
  return getAddress(r.contractAddress!);
}

/** window.ethereum for the owner: a fresh key held by this test, funded on the local chain; it signs and sends what the page asks. */
async function installChainWallet(context: BrowserContext) {
  const owner = privateKeyToAccount(generatePrivateKey());
  await rpc("anvil_setBalance", [owner.address, `0x${parseEther("10").toString(16)}`]);
  const client = createWalletClient({ account: owner, chain, transport: http(ANVIL_RPC) });
  await context.exposeBinding("__sigilWallet", async (_src, method: string, params: unknown[]) => {
    if (method === "personal_sign") return owner.signMessage({ message: { raw: (params as string[])[0] as Hex } });
    if (method === "eth_sendTransaction") {
      const tx = (params as { to?: Hex; data?: Hex; value?: Hex }[])[0];
      return client.sendTransaction({ to: tx.to ?? null, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n });
    }
    return rpc(method, params);
  });
  await context.addInitScript((address: string) => {
    const w = window as unknown as { ethereum: unknown; __sigilWallet(m: string, p: unknown[]): Promise<unknown> };
    w.ethereum = {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
        if (method === "eth_chainId") return "0x7a69";
        if (method === "wallet_switchEthereumChain") return null;
        return w.__sigilWallet(method, params ?? []);
      },
    };
  }, owner.address);
  return owner;
}

async function shot(page: Page, name: string, at?: Locator) {
  if (!SHOTS) return;
  if (at) await at.evaluate((el) => el.scrollIntoView({ block: "start" }));
  if (at) await page.evaluate(() => window.scrollBy(0, -80));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}-${PHONE ? "phone" : "desktop"}.png`) });
}

test.use({ baseURL: CHAIN_URL, bypassCSP: true });

test("the self wallet goes live on a local chain: register, create, fund, rules, payments within limits, receipts, freeze, withdraw", async ({ browser }) => {
  test.setTimeout(600_000);
  // The registry is the first contract anvil's first account deploys: the address this node was given.
  expect(await deployFromAnvil(artifact("SigilSelfRegistry.sol", "SigilSelfRegistry").bytecode.object)).toBe(ANVIL_REGISTRY);
  const token = await deployFromAnvil(artifact("SigilReview.t.sol", "SixDecimalToken").bytecode.object);
  const tokenAbi = [
    { type: "function", name: "mint", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
    { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  ] as const;

  const ctx = await browser.newContext({
    bypassCSP: true,
    baseURL: CHAIN_URL,
    permissions: ["clipboard-read", "clipboard-write"],
    ...(PHONE ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } }),
  });
  const owner = await installChainWallet(ctx);
  const page = await ctx.newPage();
  await page.goto("/vault");
  await page.getByRole("button", { name: "Create a vault" }).waitFor();
  await page.getByTestId("method-wallet").click();
  await page.getByTestId("recovery-phrase").waitFor();
  const phrase = (await page.getByTestId("recovery-phrase").locator("li").allInnerTexts()).map((w) => w.trim()).join(" ");
  await confirmPhrase(page, phrase);
  await page.getByRole("button", { name: "Open my vault" }).click();
  await page.getByRole("button", { name: "Skip the guide" }).click();

  // The self's key and its statement, as off chain.
  await openTab(page, "Identity");
  await expect(page.getByTestId("identity-offchain")).toHaveCount(0);
  await page.getByRole("button", { name: "Make the self's key" }).click();
  const selfKey = (await page.getByTestId("self-address").innerText()).trim();
  const statement = page.getByRole("form", { name: "Identity statement" });
  await statement.getByLabel("Name it goes by").fill("Sam's AI self");
  await statement.getByRole("button", { name: "Sign the statement" }).click();
  await expect(page.getByTestId("identity-statement")).toHaveAttribute("data-ok", "true");
  await expect(page.getByTestId("registry-state")).toHaveText("Not registered");

  // The owner's wallet, then the registry.
  await page.getByRole("button", { name: "Connect your wallet" }).click();
  await expect(page.getByTestId("owner-address")).toHaveText(owner.address);
  await page.getByRole("button", { name: "Register the self" }).click();
  await expect(page.getByTestId("chain-note")).toHaveText("The self is registered to your address.");
  await expect(page.getByTestId("registry-state")).toContainText("Registered to");

  // The self's wallet: deployed from the owner's wallet, linked in the registry, funded.
  await page.getByRole("button", { name: "Create the self's wallet" }).click();
  await expect(page.getByTestId("chain-note")).toContainText("linked in the registry", { timeout: 30_000 });
  const wallet = (await page.getByTestId("self-wallet").innerText()).split(",")[0].trim() as Hex;
  expect(wallet).toMatch(/^0x[0-9a-fA-F]{40}$/);
  // The code on chain is the contract Foundry builds.
  expect(await pub.getCode({ address: wallet })).toBe(artifact("SigilSelfWallet.sol", "SigilSelfWallet").deployedBytecode.object);
  expect(await pub.readContract({ address: ANVIL_REGISTRY, abi: [{ type: "function", name: "identityOf", inputs: [{ type: "address" }], outputs: [{ type: "tuple", components: [{ name: "owner", type: "address" }, { name: "wallet", type: "address" }, { name: "registeredAt", type: "uint64" }, { name: "revokedAt", type: "uint64" }, { name: "metadataURI", type: "string" }] }], stateMutability: "view" }], functionName: "identityOf", args: [selfKey as Hex] })).toMatchObject({ owner: owner.address, wallet });
  await page.getByLabel("Send to the wallet").fill("1");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("chain-note")).toHaveText("Sent 1 to the self's wallet.");
  await expect(page.getByTestId("self-wallet")).toContainText("holds 1");
  await rpc("eth_sendTransaction", [{ from: ANVIL_DEPLOYER, to: token, data: encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [wallet, parseUnits("500", 6)] }) }]);

  // The rules: a recipient, and the token with its decimals read from the token itself.
  const rules = page.getByRole("form", { name: "Wallet rules" });
  await rules.getByLabel("Per payment").fill("0.1");
  await rules.getByLabel("Per day").fill("0.2");
  await rules.getByRole("button", { name: "Add a recipient" }).click();
  await rules.getByLabel("Recipient 1 address").fill(FRIEND);
  await rules.getByLabel("Recipient 1 label").fill("A friend");
  await rules.getByLabel("New token address").fill(token);
  await rules.getByRole("button", { name: "Add a token" }).click();
  await expect(rules.getByLabel("Token 1 decimals")).toHaveValue("6");
  await rules.getByLabel("Token 1 label").fill("USD");
  await rules.getByLabel("Token 1 per payment").fill("50");
  await rules.getByLabel("Token 1 per day").fill("50");
  await expect(page.getByTestId("token-base-1")).toContainText("50,000,000 and 50,000,000 base units (6 decimals");
  await rules.getByRole("button", { name: "Save the rules" }).click();
  await expect(page.getByText("Rules saved.")).toBeVisible();
  await shot(page, "identity-rules-tokens", rules.getByText("Tokens", { exact: true }));

  // Set on chain, and read back next to the draft.
  await page.getByRole("button", { name: "Set these rules on the wallet" }).click();
  await expect(page.getByTestId("chain-note")).toHaveText("The rules are set on the wallet.");
  const compare = page.getByTestId("rules-compare");
  await expect(compare.locator("tbody tr")).not.toHaveCount(0);
  await expect(compare.locator('tbody tr[data-same="false"]')).toHaveCount(0);
  await expect(compare).toContainText("50 and 50");
  await shot(page, "identity-rules-on-chain", page.getByRole("heading", { name: "On chain" }));
  await shot(page, "identity-rules-compare", compare);

  // Try a payment: the draft and the chain answer the same.
  await rules.getByLabel("To", { exact: true }).fill(FRIEND);
  await rules.getByLabel("Amount").fill("0.5");
  await expect(page.getByTestId("rules-trial")).toHaveText("Over the cap per transaction.");
  await rules.getByRole("button", { name: "Check on chain" }).click();
  await expect(page.getByTestId("rules-trial-chain")).toHaveText("On chain: Over the cap per transaction.");
  await rules.getByLabel("Pay in").selectOption({ label: "USD" });
  await rules.getByLabel("Amount").fill("60");
  await expect(page.getByTestId("rules-trial")).toHaveText("Over the token's cap per transaction.");
  await rules.getByRole("button", { name: "Check on chain" }).click();
  await expect(page.getByTestId("rules-trial-chain")).toHaveText("On chain: Over the cap per transaction.");
  await rules.getByLabel("Amount").fill("10");
  await rules.getByRole("button", { name: "Check on chain" }).click();
  await expect(page.getByTestId("rules-trial-chain")).toHaveText("On chain: the wallet would let the self send this now.");
  await shot(page, "identity-try-on-chain", rules.getByText("Try a payment", { exact: true }));

  // Limits: the self pays listed recipients on its own, up to 0.02 each.
  await openTab(page, "Limits");
  const form = page.getByRole("form", { name: "Limits for acting" });
  await form.getByLabel("Pay listed recipients on its own").check();
  await form.getByLabel("At most per payment, in the chain's coin").fill("0.02");
  await form.getByRole("button", { name: "Save the limits" }).click();
  await expect(page.getByText("Limits saved.")).toBeVisible();
  await shot(page, "limits-form", page.getByRole("heading", { name: "Limits", exact: true }));

  // Within the limits: the self key signs, the owner's wallet sends, a receipt is kept.
  await openTab(page, "Identity");
  const payForm = page.getByRole("form", { name: "Ask the self to pay" });
  await payForm.getByLabel("To").selectOption({ label: "A friend" });
  await payForm.getByLabel("Amount").fill("0.01");
  await payForm.getByRole("button", { name: "Ask the self to pay" }).click();
  await expect(page.getByTestId("pay-outcome")).toContainText("Paid on its own, under: Payments to listed recipients, up to 0.02 each");
  expect(await pub.getBalance({ address: FRIEND })).toBe(parseEther("0.01"));
  await payForm.getByLabel("Pay in").selectOption({ label: "USD" });
  await payForm.getByLabel("Amount").fill("10");
  await payForm.getByRole("button", { name: "Ask the self to pay" }).click();
  await expect(page.getByTestId("pay-outcome")).toContainText("Paid on its own");
  expect(await pub.readContract({ address: token as Hex, abi: tokenAbi, functionName: "balanceOf", args: [FRIEND] })).toBe(parseUnits("10", 6));
  await shot(page, "identity-pay", payForm);

  // Past the limit: it waits in Work, and approving it pays.
  await payForm.getByLabel("Pay in").selectOption({ label: "The chain's coin" });
  await payForm.getByLabel("Amount").fill("0.05");
  await payForm.getByRole("button", { name: "Ask the self to pay" }).click();
  await expect(page.getByTestId("pay-outcome")).toHaveText("Waiting for you in Work: Over the most per payment you set here.");
  expect(await pub.getBalance({ address: FRIEND })).toBe(parseEther("0.01"));
  await openTab(page, "Work");
  const card = page.getByTestId("draft-card").filter({ hasText: "Pay 0.05" });
  await expect(card).toContainText("Over the most per payment you set here.");
  await shot(page, "work-payment", card);
  await card.getByRole("button", { name: "Approve and pay" }).click();
  await expect(page.getByTestId("draft-done").filter({ hasText: "Pay 0.05" })).toContainText("Signed by the self key once you approved it");
  expect(await pub.getBalance({ address: FRIEND })).toBe(parseEther("0.06"));

  // The wallet as the chain has it: today's spends, the token's caps in token units.
  await openTab(page, "Identity");
  await page.getByRole("button", { name: "Read the wallet" }).click();
  await expect(page.getByTestId("wallet-spends").locator("li")).toHaveCount(3);
  await expect(page.getByTestId("token-on-chain")).toContainText("50 USD per payment, 50 USD per day");
  await expect(page.getByTestId("token-on-chain")).toContainText("Left today 40 USD");
  await shot(page, "identity-wallet-state", page.getByTestId("wallet-state"));

  // Freeze stops the self at once; unfreeze; cancel signed calls; withdraw.
  await page.getByRole("button", { name: "Freeze the wallet now" }).click();
  await expect(page.getByTestId("chain-note")).toHaveText("The wallet is frozen.");
  await rules.getByLabel("To", { exact: true }).fill(FRIEND);
  await rules.getByLabel("Amount").fill("0.01");
  await rules.getByRole("button", { name: "Check on chain" }).click();
  await expect(page.getByTestId("rules-trial-chain")).toHaveText("On chain: The wallet is frozen.");
  await page.getByRole("button", { name: "Unfreeze" }).click();
  await expect(page.getByTestId("chain-note")).toHaveText("The wallet is active again.");
  await page.getByRole("button", { name: "Cancel signed calls" }).click();
  await expect(page.getByTestId("chain-note")).toContainText("cancelled");
  const before = await pub.getBalance({ address: owner.address });
  await page.getByLabel("Take back to your address").fill("0.5");
  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(page.getByTestId("chain-note")).toHaveText("0.5 is back at your address.");
  expect((await pub.getBalance({ address: owner.address })) - before).toBeGreaterThan(parseEther("0.49"));

  // Receipts: three, signed by the self key; once the hour (four seconds here) is sealed, one checks on the verify page.
  await page.waitForTimeout(6_000);
  await openTab(page, "Limits");
  await expect(page.getByTestId("receipt")).toHaveCount(3);
  await expect(page.getByTestId("receipt").first()).toContainText("Sealed in hour");
  await shot(page, "limits-receipts", page.getByRole("heading", { name: "Receipts" }));
  await page.getByTestId("receipt").first().getByRole("button", { name: "Copy" }).click();
  const file = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(file).receipt.body.selfKey).toBe(selfKey);
  const verify = await ctx.newPage();
  await verify.goto("/verify");
  await verify.locator("#doc-text").fill(file);
  await verify.getByRole("button", { name: "Check it" }).click();
  const result = verify.getByTestId("document-result");
  await expect(result).toHaveAttribute("data-ok", "true");
  await expect(result).toContainText(`Signed by the self key ${selfKey}`);
  await expect(result).toContainText("The root is the one this site published");
  await expect(result).toContainText("Sam's AI self");
  await verify.locator("#doc-text").fill(file.replace("Paid", "Sent"));
  await verify.getByRole("button", { name: "Check it" }).click();
  await expect(result).toHaveAttribute("data-ok", "false");
  if (SHOTS) {
    await verify.locator("#doc-text").fill(file);
    await verify.getByRole("button", { name: "Check it" }).click();
    await expect(result).toHaveAttribute("data-ok", "true");
    await shot(verify, "verify-receipt", verify.locator("#doc-text"));
  }
  await ctx.close();
});
