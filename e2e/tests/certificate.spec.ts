// Proof of a real life: the open vault signs its presence each seal period
// (four seconds on the test server), a certificate is built and signed in the
// browser, downloaded and shared by link, and checked on the verify page by
// someone with no vault. A changed file does not pass.

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createWithWallet, installWallet, recordBodies, writeMemory, openTab } from "./helpers";

const CANARY = "CANARY-cert-e2e-5e0a";

test("a life certificate is made from sealed presence, shared, and verified in another browser", async ({ browser }) => {
  const ctx = await browser.newContext({ acceptDownloads: true });
  await installWallet(ctx);
  const page = await ctx.newPage();
  const wire = recordBodies(page);
  await createWithWallet(page);
  await writeMemory(page, { title: "Private", body: CANARY });

  // Keep the vault open over a few seal periods.
  await page.waitForTimeout(11_000);
  await openTab(page, "Proof");
  await page.getByRole("button", { name: "Make a certificate" }).click();
  const cert = page.getByTestId("certificate");
  await expect(cert).toHaveAttribute("data-ok", "true");
  await expect(cert).toContainText("of continuous sealed history");
  await expect(cert.locator(".certificate-checks li")).toHaveCount(5);

  const download = page.waitForEvent("download");
  await cert.getByRole("button", { name: "Download" }).click();
  const file = await (await download).path();
  const text = readFileSync(file!, "utf8");
  expect(JSON.parse(text)).toMatchObject({ format: "sigil-life-certificate", version: 1 });
  expect(text).not.toContain(CANARY);

  await cert.getByRole("button", { name: "Make a share link" }).click();
  const link = (await page.getByTestId("certificate-link").innerText()).trim();
  expect(link).toMatch(/\/verify\?certificate=[A-Za-z0-9_-]+$/);

  // Someone without a vault opens the link.
  const visitorCtx = await browser.newContext();
  const visitor = await visitorCtx.newPage();
  await visitor.goto(link);
  const result = visitor.getByTestId("certificate-result");
  await expect(result).toHaveAttribute("data-ok", "true");
  await expect(result.locator(".verifier-verdict")).toHaveText("Verified");
  await expect(result).toContainText("not anchored on chain");

  // A certificate that claims more than it holds does not pass.
  const forged = JSON.parse(text);
  forged.body.summary.activeHours += 100;
  await visitor.goto("/verify#certificate");
  await visitor.getByLabel("A certificate file").setInputFiles({ name: "forged.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(forged)) });
  await expect(result).toHaveAttribute("data-ok", "false");
  await expect(result.locator(".verifier-verdict")).toHaveText("Not verified");

  // Taken down, the link stops working.
  await page.getByRole("button", { name: "Take down" }).click();
  await visitor.goto(link);
  await expect(visitor.locator(".certificate-checker")).toContainText("no certificate at this link");

  expect(wire.join("\n")).not.toContain(CANARY);
  await ctx.close();
  await visitorCtx.close();
});
