// Permanent storage in real browsers: the owner downloads the vault as one
// encrypted bundle, and restores it into an empty vault on another node with
// the recovery phrase. Every memory comes back; nothing readable reached
// either node.

import { expect, test } from "@playwright/test";
import { createWithWallet, fitsPhone, installWallet, recordBodies, writeMemory } from "./helpers";
import { SECOND_URL } from "../playwright.config";

const CANARY = "CANARY-bundle-e2e-5a1";

test("a vault is downloaded as a bundle and restored on another node with the recovery phrase", async ({ page, context, browser }) => {
  await installWallet(context);
  const sent = recordBodies(page);
  const phrase = await createWithWallet(page);
  await writeMemory(page, { title: "Where I parked", body: `Level 3, by the lift. ${CANARY}` });

  await page.getByRole("tab", { name: "Storage" }).click();
  await expect(page.getByTestId("node-list")).toContainText("Lives here");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("bundle-download").click()]);
  expect(download.suggestedFilename()).toMatch(/^sigil-\d{8}T\d{6}Z-[0-9a-f]{12}\.sigil$/);
  const file = await download.path();
  await expect(page.getByTestId("backup-run").first()).toContainText("A file on this device");
  await fitsPhone(page, "Storage");
  expect(sent.join("\n")).not.toContain(CANARY);

  // An empty node, a fresh browser: only the file and the phrase.
  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  const otherSent = recordBodies(other);
  await other.goto(`${SECOND_URL}/vault`);
  await other.getByTestId("restore-link").click();
  await expect(other.getByRole("heading", { name: "Restore a vault" })).toBeVisible();
  await other.getByLabel("The bundle file").setInputFiles(file!);
  await expect(other.getByTestId("restore-facts")).toContainText("Memories");
  await expect(other.locator(".restore")).toContainText("Its hash covers every part.");
  await fitsPhone(other, "Restore, the bundle read");
  await other.getByLabel("Recovery phrase").fill(phrase);
  await other.getByRole("button", { name: "Open with my phrase" }).click();
  await expect(other.getByTestId("restore-done")).toContainText("restored");
  await other.getByRole("button", { name: "Open your vault" }).click();
  await expect(other.getByRole("heading", { name: "Your vault", exact: true })).toBeVisible();
  await other.getByRole("tab", { name: "Memories" }).click();
  await other.locator(".memory-item-title", { hasText: "Where I parked" }).click();
  await expect(other.getByLabel("Memory", { exact: true })).toHaveValue(`Level 3, by the lift. ${CANARY}`);
  // The new node's log says where the vault came from.
  await other.getByRole("tab", { name: "Read log" }).click();
  await expect(other.locator(".log-row", { hasText: "The vault was restored on this node from a bundle" })).toBeVisible();
  expect(otherSent.join("\n")).not.toContain(CANARY);
  expect(otherSent.join("\n")).not.toContain(phrase.split(" ").slice(0, 6).join(" "));
  await fresh.close();
});
