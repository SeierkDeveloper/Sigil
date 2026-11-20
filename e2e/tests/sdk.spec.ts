// Sign in with Sigil end to end: a web app on another origin opens the vault's
// consent window, the owner unlocks and allows one folder, and the app reads it,
// decrypting in its own page. The app shows up under Apps and in the read log.

import { expect, test } from "@playwright/test";
import type { Server } from "node:http";
import { createWithWallet, installWallet, writeMemory } from "./helpers";

const EXAMPLE_PORT = 3211;
let example: Server;

test.beforeAll(async () => {
  const { startExample } = await import("../../examples/hello-sigil/serve.mjs");
  example = await startExample(EXAMPLE_PORT);
});
test.afterAll(async () => {
  await new Promise((r) => example?.close(r));
});

test("a web app asks, the owner allows one folder, the app reads it", async ({ page, context, baseURL }) => {
  await installWallet(context);
  await createWithWallet(page);
  await writeMemory(page, { title: "Launch plan", body: "Ship on a Tuesday." });

  const app = await context.newPage();
  await app.goto(`http://127.0.0.1:${EXAMPLE_PORT}/`);
  await app.getByLabel("Address of your Sigil site").fill(baseURL!);
  const [popup] = await Promise.all([app.waitForEvent("popup"), app.getByRole("button", { name: "Sign in with Sigil" }).click()]);

  // The consent window: unlock, then choose.
  await popup.getByTestId("method-wallet").click();
  await expect(popup.getByRole("heading", { name: "Hello Sigil asks to read your vault" })).toBeVisible();
  await expect(popup.locator(".consent-origin")).toContainText(`http://127.0.0.1:${EXAMPLE_PORT}`);
  await expect(popup.getByRole("button", { name: "Allow" })).toBeDisabled();
  await popup.getByLabel("Notes", { exact: true }).check();
  await popup.getByRole("button", { name: "Allow reading Notes" }).click();
  await popup.waitForEvent("close");

  // The app reads what it was given.
  await expect(app.locator("#who")).toContainText(`Connected to the vault at ${baseURL}`);
  await expect(app.locator("#folders")).toContainText("Notes (1)");
  await app.getByLabel("Search them").fill("tuesday");
  await app.getByRole("button", { name: "Launch plan" }).click();
  await expect(app.locator("#memory")).toContainText("Ship on a Tuesday.");

  // The vault lists it as a web app, and its reads are on the record.
  await page.reload();
  await page.getByTestId("method-wallet").click();
  await page.getByRole("tab", { name: "Apps" }).click();
  await expect(page.locator(".app-row", { hasText: `Hello Sigil (127.0.0.1:${EXAMPLE_PORT})` })).toContainText("Web app");
  await page.getByRole("tab", { name: "Read log" }).click();
  await expect(page.locator(".log-row", { hasText: 'Read "Launch plan"' })).toContainText("Hello Sigil");

  // Revoke it, and the app's next read fails.
  await page.getByRole("tab", { name: "Apps" }).click();
  const row = page.locator(".app-row", { hasText: "Hello Sigil" });
  await row.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("button", { name: "Revoke access" }).click();
  await app.reload();
  await expect(app.locator("#status")).toContainText("revoked");
});

test("a denied request hands nothing over", async ({ page, context, baseURL }) => {
  await installWallet(context);
  await createWithWallet(page);
  const app = await context.newPage();
  await app.goto(`http://127.0.0.1:${EXAMPLE_PORT}/`);
  await app.getByLabel("Address of your Sigil site").fill(baseURL!);
  const [popup] = await Promise.all([app.waitForEvent("popup"), app.getByRole("button", { name: "Sign in with Sigil" }).click()]);
  await popup.getByTestId("method-wallet").click();
  await popup.getByRole("button", { name: "Deny" }).click();
  await expect(app.locator("#status")).toContainText("did not allow access");
  await page.reload();
  await page.getByTestId("method-wallet").click();
  await page.getByRole("tab", { name: "Apps" }).click();
  await expect(page.getByText("No apps connected yet")).toBeVisible();
});
