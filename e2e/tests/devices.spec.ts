// Phone and every device: add a device by its short code (the QR code holds the
// same link), open the vault on it with its own device key, capture into the
// inbox from it, revoke it, and the installable app shell that works offline.

import { expect, test, type Page } from "@playwright/test";
import { createWithWallet, installWallet, recordBodies, writeMemory, openTab } from "./helpers";

const CANARY = "CANARY-device-e2e-4410";

async function unlock(page: Page) {
  await page.goto("/vault");
  await page.getByTestId("method-wallet").click();
  await expect(page.getByRole("heading", { name: "Your vault", exact: true })).toBeVisible();
}

test("add a device by code, open the vault there, capture from it, and revoke it", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  await installWallet(ownerCtx);
  const owner = await ownerCtx.newPage();
  await createWithWallet(owner);
  await writeMemory(owner, { title: "Bike lock", body: `Code is four digits. ${CANARY}` });

  // The new device has no wallet and no passkey: it shows a one-time code.
  const phoneCtx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const phone = await phoneCtx.newPage();
  const phoneWire = recordBodies(phone);
  await phone.goto("/vault");
  await phone.getByRole("button", { name: "Add this device" }).click();
  const code = (await phone.getByTestId("pair-code").innerText()).trim();
  expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  await expect(phone.getByRole("img", { name: "Pairing code for this device" })).toBeVisible();
  const phonePrint = (await phone.locator(".pair-new .fingerprint").innerText()).replace(/\s+/g, " ").trim();

  // The signed-in device types the code, compares the fingerprint and sends the vault.
  await openTab(owner, "Devices");
  await owner.getByLabel("Code on the new device").fill(code.toLowerCase());
  await owner.getByRole("button", { name: "Find the device" }).click();
  const confirm = owner.getByTestId("pair-confirm");
  await expect(confirm.locator(".fingerprint")).toHaveText(phonePrint);
  await confirm.getByLabel("Name it").fill("Test phone");
  await confirm.getByRole("button", { name: /It matches: send my vault/ }).click();
  await expect(owner.getByText("Test phone received your vault.")).toBeVisible();
  await expect(owner.locator(".device-row")).toContainText("Test phone");

  // The phone opens the same vault.
  await expect(phone.getByRole("heading", { name: "Your vault", exact: true })).toBeVisible();
  await expect(phone.locator(".memory-item-title", { hasText: "Bike lock" })).toBeVisible();

  // Next time it opens with its own device key.
  await phone.reload();
  await phone.getByTestId("method-device").click();
  await expect(phone.getByRole("heading", { name: "Your vault", exact: true })).toBeVisible();
  await openTab(phone, "Devices");
  await expect(phone.locator(".device-row[data-this='true']")).toContainText("Test phone");

  // Quick capture from the phone: sealed there, waiting in the inbox.
  await phone.goto("/capture");
  await phone.getByLabel("What to keep").fill(`Parked on level 3. ${CANARY}`);
  await phone.getByRole("button", { name: "Seal and send" }).click();
  await expect(phone.getByText("Sealed and in your inbox.")).toBeVisible();
  await unlock(owner);
  await openTab(owner, "Inbox");
  const proposal = owner.getByTestId("proposal");
  await expect(proposal.locator(".proposal-from")).toContainText("You with quick capture");
  await expect(proposal.getByLabel("Memory")).toHaveValue(`Parked on level 3. ${CANARY}`);

  // Revoke: the phone's next sign-in fails, and it forgets its device key.
  await openTab(owner, "Devices");
  await owner.locator(".device-row").getByRole("button", { name: "Revoke" }).click();
  await owner.locator(".device-row").getByRole("button", { name: "Revoke" }).click();
  await expect(owner.locator(".device-row")).toHaveCount(0);
  await phone.goto("/vault");
  await phone.getByTestId("method-device").click();
  await expect(phone.getByText(/This device was removed from the vault/)).toBeVisible();
  await phone.reload();
  await expect(phone.getByTestId("method-device")).toHaveCount(0);

  await openTab(owner, "Read log");
  await expect(owner.locator(".log-row", { hasText: "A device was revoked" })).toBeVisible();
  await expect(owner.locator(".log-row", { hasText: "A device was added by code" })).toBeVisible();

  expect(phoneWire.join("\n")).not.toContain(CANARY);
  await ownerCtx.close();
  await phoneCtx.close();
});

test("the app installs: a manifest with a share target, and a service worker that opens the vault offline", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ name: "Sigil", start_url: "/vault", display: "standalone", share_target: { action: "/capture", method: "POST" } });
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  expect((await page.request.get("/icons/icon-512.png")).headers()["content-type"]).toContain("image/png");

  await page.goto("/vault");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  // Once the worker controls the page, the shell is kept as it loads.
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.goto("/capture");
  await page.goto("/vault");
  await expect(page.getByRole("heading", { name: /Create your vault|Unlock your vault|Sign in to your vault/ })).toBeVisible();

  await ctx.setOffline(true);
  await page.reload();
  await expect(page.getByText("Sigil could not be reached.")).toBeVisible();
  await page.goto("/capture");
  await expect(page.getByRole("heading", { name: "Into your inbox" })).toBeVisible();
  await ctx.setOffline(false);
  await ctx.close();
});
