// The AI self's identity with no chain configured: the tab says so plainly,
// the self key is made on the device, a statement is signed by both keys and
// read by anyone at its address, and the wallet rules are drafted, checked and
// kept encrypted. Nothing reaches any chain.

import { expect, test } from "@playwright/test";
import { parseIdentityStatement, verifyIdentityStatement } from "@sigil/core";
import { createWithWallet, installWallet, recordBodies, openTab } from "./helpers";

test("the identity tab works off chain: key, signed statement, wallet rules", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext();
  await installWallet(ctx);
  const page = await ctx.newPage();
  const wire = recordBodies(page);
  await createWithWallet(page);

  await openTab(page, "Identity");
  await expect(page.getByTestId("identity-offchain")).toContainText("no registry of AI selves on chain yet");
  await page.getByRole("button", { name: "Make the self's key" }).click();
  const address = (await page.getByTestId("self-address").innerText()).trim();
  expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);

  const form = page.getByRole("form", { name: "Identity statement" });
  await form.getByLabel("Name it goes by").fill("Sam's AI self");
  await form.getByLabel("What it is for").fill("CANARY-about Answers questions about my work.");
  await form.getByRole("button", { name: "Sign the statement" }).click();
  const signed = page.getByTestId("identity-statement");
  await expect(signed).toHaveAttribute("data-ok", "true");
  await expect(signed.locator(".proof-steps li")).toHaveCount(2);

  // Anyone can read the statement at its address and check both signatures.
  const res = await page.request.get(`${baseURL}/api/identity/at/${address}`);
  expect(res.ok()).toBe(true);
  const statement = parseIdentityStatement(await res.text());
  expect(statement.body).toMatchObject({ selfKey: address, name: "Sam's AI self", chain: null });
  expect(verifyIdentityStatement(statement).ok).toBe(true);

  // Wallet rules: drafted, checked on the device, saved encrypted.
  const rules = page.getByRole("form", { name: "Wallet rules" });
  await rules.getByLabel("Per payment").fill("0.05");
  await rules.getByLabel("Per day").fill("0.2");
  await rules.getByRole("button", { name: "Add a recipient" }).click();
  await rules.getByLabel("Recipient 1 address").fill("0x1111111111111111111111111111111111111111");
  await rules.getByLabel("Recipient 1 label").fill("CANARY-friend");
  await rules.getByLabel("To", { exact: true }).fill("0x1111111111111111111111111111111111111111");
  await rules.getByLabel("Amount").fill("0.1");
  await expect(page.getByTestId("rules-trial")).toHaveText("Over the cap per transaction.");
  await rules.getByLabel("Amount").fill("0.05");
  await expect(page.getByTestId("rules-trial")).toHaveText("The wallet would let the self send this.");
  await rules.getByLabel("To", { exact: true }).fill("0x2222222222222222222222222222222222222222");
  await expect(page.getByTestId("rules-trial")).toHaveText("This address is not one of the recipients.");
  await rules.getByRole("button", { name: "Save the rules" }).click();
  await expect(page.getByText("Rules saved.")).toBeVisible();

  // After a reload the draft is back, opened on the device.
  await page.reload();
  await page.getByTestId("method-wallet").click();
  await openTab(page, "Identity");
  await expect(page.getByRole("form", { name: "Wallet rules" }).getByLabel("Recipient 1 label")).toHaveValue("CANARY-friend");
  await expect(page.getByTestId("self-address")).toHaveText(address);

  // The rules never left the device readable, and nothing went anywhere but this site.
  expect(wire.filter((b) => b.includes("CANARY-friend"))).toEqual([]);
  expect(wire.filter((b) => /^https?:\/\//.test(b) && !b.startsWith(baseURL!))).toEqual([]);
  await ctx.close();
});
