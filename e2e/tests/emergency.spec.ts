// Emergency access: a medical card filled from a health memory, changed by the
// owner, published as ciphertext under a key that lives only in the link,
// opened on a phone at 375 pixels by someone with no vault, the opening seen
// by the owner, then taken down and issued again under a new code.

import { expect, test } from "@playwright/test";
import { addFolder, createWithWallet, installWallet, recordBodies, writeMemory } from "./helpers";

const ALLERGY = "CANARY-penicillin";

test("the emergency card opens from its link on a phone, is logged for the owner, and can be revoked and re-issued", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext();
  await installWallet(ctx);
  const page = await ctx.newPage();
  const wire = recordBodies(page);
  await createWithWallet(page);
  await addFolder(page, "Health");
  await writeMemory(page, { title: "Medical", body: `Blood type: O-\nAllergies: ${ALLERGY}\nEmergency contact: Robin Example, partner, +46 70 000 00 00`, folder: "Health" });

  await page.getByRole("tab", { name: "Emergency" }).click();
  await page.getByLabel("Medical").check();
  await page.getByRole("button", { name: "Fill the card from these" }).click();
  const form = page.getByRole("form", { name: "Emergency card" });
  await expect(form.getByLabel("Blood type")).toHaveValue("O-");
  await expect(form.getByLabel("Allergies")).toHaveValue(ALLERGY);
  await expect(form.getByLabel("Contact 1 phone")).toHaveValue("+46 70 000 00 00");
  // The owner edits before it goes out.
  await form.getByLabel("Name", { exact: true }).fill("Sam Example");
  await form.getByLabel("Languages").fill("English, Swedish");
  await form.getByRole("button", { name: "Publish the card" }).click();
  await expect(page.getByText("Published. Set the code below as your lock screen.")).toBeVisible();
  const link = (await page.getByTestId("emergency-link").innerText()).trim();
  expect(link).toMatch(/\/e\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]{43}$/);
  await expect(page.locator(".emergency-code .qr")).toBeVisible();

  // A helper's phone scans it.
  const phoneCtx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile", locale: "sv-SE" });
  const phone = await phoneCtx.newPage();
  const phoneWire = recordBodies(phone);
  await phone.goto(link);
  const sheet = phone.getByTestId("emergency-sheet");
  await expect(phone.getByTestId("emergency-blood")).toHaveText("O-");
  await expect(sheet).toContainText(ALLERGY);
  await expect(sheet).toContainText("Sam Example");
  await expect(sheet.getByRole("link", { name: /Robin Example, partner/ })).toHaveAttribute("href", "tel:+46700000000");
  const width = await phone.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
  // The key never went to the server.
  expect(phoneWire.join("\n")).not.toContain(link.split("#")[1]);

  // The owner sees the opening: when, a phone, Swedish.
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByTestId("emergency-open").first()).toContainText("A phone, language sv");

  // Taken down: the link opens nothing.
  await page.getByRole("button", { name: "Take it down" }).click();
  await expect(page.getByText("Taken down. The code opens nothing now.")).toBeVisible();
  await phone.reload();
  await expect(sheet).toContainText("took this card down");

  // Issued again: a new code, and the old one still opens nothing.
  await form.getByRole("button", { name: "Publish the card" }).click();
  const fresh = (await page.getByTestId("emergency-link").innerText()).trim();
  expect(fresh).not.toBe(link);
  await phone.goto(fresh);
  await expect(phone.getByTestId("emergency-blood")).toHaveText("O-");
  await phone.goto(link);
  await expect(sheet).toContainText("took this card down");

  expect(wire.filter((b) => b.includes(baseURL!)).join("\n")).not.toContain(ALLERGY);
  await phoneCtx.close();
  await ctx.close();
});
