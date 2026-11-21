// Capture from anywhere: the owner makes a capture key under Devices, a
// shortcut opens the capture page with what was said, the page seals it on
// that device, and it lands in the inbox named by its key. Revoked, it stops.

import { expect, test } from "@playwright/test";
import { createWithWallet, fitsPhone, installWallet, recordBodies, openTab } from "./helpers";

const SAID = "Remember that I parked on level 3 CANARY-capture-e2e-9b";

test("a capture key puts what a shortcut sends into the inbox, sealed on the sending device", async ({ page, context, browser }) => {
  await installWallet(context);
  await createWithWallet(page);
  await openTab(page, "Devices");
  const form = page.getByRole("form", { name: "New capture key" });
  await form.getByLabel("Name", { exact: true }).fill("Phone shortcut");
  await form.getByRole("button", { name: "Make a capture key" }).click();
  const key = (await page.getByTestId("capture-key").innerText()).trim();
  expect(key).toMatch(/^sigil_cap\./);
  await expect(page.getByTestId("capture-made")).toContainText("Apple shortcut");
  await fitsPhone(page, "Devices, a capture key made");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("capture-key-row")).toContainText("Phone shortcut");

  // The phone: no vault, no session, only the link the shortcut opens.
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneCtx.newPage();
  const sent = recordBodies(phone);
  await phone.goto(`/c#k=${encodeURIComponent(key)}&t=${encodeURIComponent(SAID)}`);
  await expect(phone.getByText("Sealed and in your inbox.")).toBeVisible();
  expect(new URL(phone.url()).hash).not.toContain("parked");
  const wire = sent.join("\n");
  expect(wire).not.toContain("CANARY-capture-e2e-9b");
  expect(wire).not.toContain(key.split(".")[2]);
  await fitsPhone(phone, "The capture page, sent");

  await openTab(page, "Inbox");
  await page.reload();
  await page.getByTestId("method-wallet").click();
  await openTab(page, "Inbox");
  const card = page.getByTestId("proposal").first();
  await expect(card).toContainText("You, with Phone shortcut");
  await expect(card.getByLabel("Memory", { exact: true })).toHaveValue(SAID);
  await openTab(page, "Read log");
  await expect(page.locator(".log-row", { hasText: "Sent something to your inbox" })).toContainText('Capture key "Phone shortcut"');

  // Revoked: the same link stops working on the next request.
  await openTab(page, "Devices");
  await page.getByTestId("capture-key-row").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("capture-key-row")).toContainText("Revoked");
  const again = await phoneCtx.newPage();
  await again.goto(`/c#k=${encodeURIComponent(key)}&t=${encodeURIComponent("once more")}`);
  await expect(again.locator(".notice-error")).toContainText("revoked");
  await phoneCtx.close();
});
