// Sharing a folder between two vaults in two browsers: the code and its
// fingerprint, accept, read only, the owner's read log, and revoke by a new key.

import { expect, test, type Page } from "@playwright/test";
import { addFolder, createWithWallet, installWallet, recordBodies, writeMemory } from "./helpers";

const CANARY = "CANARY-share-e2e-0c7d";

async function unlock(page: Page) {
  await page.reload();
  await page.getByTestId("method-wallet").click();
  await expect(page.getByRole("heading", { name: "Your vault" })).toBeVisible();
}

test("share a folder, accept it read only, see it in the log, stop sharing", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const friendCtx = await browser.newContext();
  await installWallet(ownerCtx);
  await installWallet(friendCtx);
  const owner = await ownerCtx.newPage();
  const friend = await friendCtx.newPage();
  const ownerWire = recordBodies(owner);
  const friendWire = recordBodies(friend);

  // The friend makes a vault and reads out its code.
  await createWithWallet(friend);
  await friend.getByRole("tab", { name: "Folders" }).click();
  const code = (await friend.getByTestId("vault-code").innerText()).trim();
  expect(code).toMatch(/^sigil_vault\./);
  const fingerprint = (await friend.locator(".vault-code .mono").innerText()).trim();

  // The owner shares a folder with that code.
  await createWithWallet(owner);
  await addFolder(owner, "Family");
  await writeMemory(owner, { title: "Grandma's bread", body: `Rye and honey. ${CANARY}`, folder: "Family" });
  await owner.getByRole("tab", { name: "Folders" }).click();
  const row = owner.locator(".list-row", { hasText: "Family" }).first();
  await row.getByRole("button", { name: "Share" }).click();
  await owner.getByLabel("Their vault code").fill(code);
  await expect(owner.locator(".share-form .field-hint").first()).toContainText(fingerprint);
  await owner.getByLabel("What you call them").fill("My sister");
  await owner.getByLabel("Your name, as they see it").fill("Alex");
  await owner.getByRole("button", { name: "Share folder" }).click();
  await expect(owner.locator(".share-row")).toContainText("Shared with My sister, waiting for them to accept");

  // The friend accepts and reads it, read only.
  await unlock(friend);
  await friend.getByRole("tab", { name: "Folders" }).click();
  const shared = friend.locator(".shared-row");
  await expect(shared).toContainText("Family");
  await expect(shared).toContainText("From Alex");
  await shared.getByRole("button", { name: "Accept" }).click();
  await expect(shared).toContainText("Read only");
  await friend.getByRole("tab", { name: "Memories" }).click();
  await friend.locator(".memory-item", { hasText: "Grandma's bread" }).click();
  await expect(friend.locator(".editor-readonly")).toContainText(`Rye and honey. ${CANARY}`);
  await expect(friend.locator(".editor-readonly")).toContainText("shared with you by Alex. Read only.");

  // The owner sees the opening in the read log.
  await unlock(owner);
  await owner.getByRole("tab", { name: "Read log" }).click();
  await expect(owner.locator(".log-row", { hasText: "Opened a folder you share with them" }).first()).toContainText("My sister");

  // Stop sharing: a new key for the folder, and the friend loses it.
  await owner.getByRole("tab", { name: "Folders" }).click();
  await owner.locator(".share-row").getByRole("button", { name: "Stop sharing" }).click();
  await owner.locator(".share-row").getByRole("button", { name: "Stop sharing" }).click();
  await expect(owner.locator(".share-row")).toHaveCount(0);
  await owner.getByRole("tab", { name: "Memories" }).click();
  await owner.locator(".memory-item", { hasText: "Grandma's bread" }).click();
  await expect(owner.getByLabel("Memory", { exact: true })).toHaveValue(`Rye and honey. ${CANARY}`);

  await unlock(friend);
  await friend.getByRole("tab", { name: "Folders" }).click();
  await expect(friend.locator(".shared-row")).toHaveCount(0);
  await friend.getByRole("tab", { name: "Memories" }).click();
  await expect(friend.locator(".memory-item", { hasText: "Grandma's bread" })).toHaveCount(0);

  for (const wire of [ownerWire, friendWire]) {
    const all = wire.join("\n");
    for (const secret of [CANARY, "Grandma", "My sister"]) expect(all, `"${secret}" was sent to the server`).not.toContain(secret);
  }
  await ownerCtx.close();
  await friendCtx.close();
});
