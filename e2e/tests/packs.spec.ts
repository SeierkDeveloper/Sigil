// Knowledge packs across two browsers: Sam publishes a folder as a signed
// pack, Robin opens its page, follows it into a folder of their own, and takes
// in the next version when their vault opens again.

import { expect, test, type Page } from "@playwright/test";
import { addFolder, createWithWallet, installWallet, writeMemory, openTab } from "./helpers";

async function unlock(page: Page) {
  await page.getByTestId("method-wallet").click();
  await expect(page.getByRole("heading", { name: "Your vault" })).toBeVisible();
}

test("a folder is published as a pack, followed from another vault, and updated to its next version", async ({ browser }) => {
  const samCtx = await browser.newContext();
  const robinCtx = await browser.newContext();
  await installWallet(samCtx);
  await installWallet(robinCtx);
  const sam = await samCtx.newPage();
  const robin = await robinCtx.newPage();

  await createWithWallet(sam);
  await addFolder(sam, "Bread");
  await writeMemory(sam, { title: "Starter", body: "Feed it twice a day.", folder: "Bread" });
  await openTab(sam, "Packs");
  const publish = sam.getByRole("form", { name: "Publish a folder" });
  await publish.getByLabel("Folder").selectOption({ label: "Bread" });
  await publish.getByLabel("Title").fill("Bread at home");
  await publish.getByLabel("What it is").fill("How I bake.");
  await publish.getByRole("button", { name: "Publish as a pack" }).click();
  await expect(sam.getByText("Version 1 is published.")).toBeVisible();
  const link = (await sam.getByTestId("pack-link").innerText()).trim();

  // Robin, with a vault of their own, opens the pack's page and follows it.
  await createWithWallet(robin);
  await robin.goto(link);
  const card = robin.getByTestId("pack-page");
  await expect(card).toHaveAttribute("data-ok", "true");
  await expect(robin.getByRole("heading", { name: "Bread at home" })).toBeVisible();
  await card.getByRole("link", { name: "Follow in your vault" }).click();
  await unlock(robin);
  await expect(robin.getByRole("tab", { name: "Packs" })).toHaveAttribute("aria-selected", "true");
  await robin.getByRole("form", { name: "Follow a pack" }).getByRole("button", { name: "Follow", exact: true }).click();
  await expect(robin.getByText("Following Bread at home: 1 memory in the folder Pack: Bread at home.")).toBeVisible();
  await expect(robin.getByTestId("follow-row")).toContainText("Version 1");

  // Sam adds a memory and publishes the next version.
  await writeMemory(sam, { title: "Oven", body: "250 degrees.", folder: "Bread" });
  await openTab(sam, "Packs");
  await sam.getByRole("form", { name: "Publish a folder" }).getByLabel("Folder").selectOption({ label: "Bread" });
  await sam.getByRole("button", { name: "Publish version 2" }).click();
  await expect(sam.getByText("Version 2 is published.")).toBeVisible();

  // Robin's vault takes it in the next time it opens, checked against Sam's key.
  await robin.goto("/vault#packs");
  await unlock(robin);
  await openTab(robin, "Packs");
  await expect(robin.getByTestId("follow-row")).toContainText("Version 2", { timeout: 20_000 });
  await openTab(robin, "Memories");
  await expect(robin.locator(".memory-item-title", { hasText: "Oven" })).toBeVisible();

  await openTab(robin, "Read log");
  await expect(robin.getByText("Version 2 of the pack was taken in, checked against its publisher")).toBeVisible();
  await samCtx.close();
  await robinCtx.close();
});
