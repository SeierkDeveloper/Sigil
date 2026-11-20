// Memory that thinks, in a real browser: the weekly brief, memories that
// disagree, expiry, and merging every duplicate group at once.

import { expect, test } from "@playwright/test";
import { createWithWallet, installWallet, recordBodies, writeMemory } from "./helpers";

const CANARY = "CANARY-review-e2e-8a1c";

test("the weekly brief is written on the device and saved into Briefs", async ({ page, context, baseURL }) => {
  await installWallet(context);
  const sent = recordBodies(page);
  await createWithWallet(page);
  await writeMemory(page, { title: `Garden ${CANARY}`, body: "Planted tomatoes by the south wall." });

  await page.getByRole("tab", { name: "Review" }).click();
  await expect(page.getByText("No brief yet.")).toBeVisible();
  await page.getByRole("button", { name: "Make a brief now" }).click();
  const brief = page.getByTestId("brief-latest");
  await expect(brief).toContainText("Weekly brief,");
  await expect(brief).toContainText("## What is new");
  await expect(brief).toContainText(`Garden ${CANARY}`);
  await page.getByRole("tab", { name: "Folders" }).click();
  await expect(page.locator(".list-row-title", { hasText: "Briefs" })).toBeVisible();
  expect(sent.filter((b) => b.includes(baseURL!)).join("\n")).not.toContain(CANARY);
});

test("memories that disagree are shown, and resolved by keeping one", async ({ page, context }) => {
  await installWallet(context);
  await createWithWallet(page);
  await writeMemory(page, { title: "Coffee", body: "I drink coffee every morning before work." });
  await writeMemory(page, { title: "Coffee rule", body: "I never drink coffee before work in the morning." });
  await writeMemory(page, { title: "Garden", body: "Tomatoes by the south wall." });
  await page.getByRole("tab", { name: "Review" }).click();
  const pair = page.getByTestId("contradiction");
  await expect(pair).toHaveCount(1);
  await expect(pair).toContainText("One says no where the other says yes");
  await pair.getByRole("button", { name: 'Keep "Coffee rule"' }).click();
  await expect(page.getByText("No memories that disagree.")).toBeVisible();
  await page.getByRole("tab", { name: "Memories" }).click();
  await expect(page.locator(".memory-item-title", { hasText: /^Coffee$/ })).toHaveCount(0);
});

test("an expired memory leaves the list, waits in Expired, and can be kept", async ({ page, context }) => {
  await installWallet(context);
  await createWithWallet(page);
  await writeMemory(page, { title: "Door code", body: "4512 until the lock is changed." });
  await page.locator(".memory-item-title", { hasText: "Door code" }).click();
  const yesterday = new Date(Date.now() - 86_400_000);
  const day = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
  await page.getByLabel("Expires").fill(day);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".memory-item-title", { hasText: "Door code" })).toHaveCount(0);

  await page.getByRole("tab", { name: "Review" }).click();
  const row = page.getByTestId("expired-row");
  await expect(row).toContainText("Door code");
  await expect(row).toContainText("Deleted for real on");
  await row.getByRole("button", { name: "Keep it" }).click();
  await expect(page.getByText("Nothing has expired.")).toBeVisible();
  await page.getByRole("tab", { name: "Memories" }).click();
  await expect(page.locator(".memory-item-title", { hasText: "Door code" })).toBeVisible();
});

test("every duplicate group is merged after one approval", async ({ page, context }) => {
  await installWallet(context);
  await createWithWallet(page);
  for (let i = 0; i < 3; i++) await writeMemory(page, { title: "Allergy", body: "Allergic to penicillin.", tags: `t${i}` });
  for (let i = 0; i < 2; i++) await writeMemory(page, { title: "Bike", body: "The lock code is in the drawer." });
  await page.getByRole("button", { name: "Find duplicates" }).click();
  const all = page.getByTestId("merge-all");
  await expect(all).toContainText("in 2 groups");
  await all.getByRole("button", { name: "Merge every group" }).click();
  await all.getByRole("button", { name: "Merge into 2 memories" }).click();
  await expect(page.getByText("No duplicates found.")).toBeVisible();
  await expect(page.locator(".memory-item")).toHaveCount(2);
});
