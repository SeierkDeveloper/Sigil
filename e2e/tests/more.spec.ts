// A simpler vault: five sections in the main row, every other one under More
// in its four groups, pins that keep a section in the row on this device, and
// every deep link (#agents, #emergency, ...) working as before.

import { expect, test } from "@playwright/test";
import { createWithWallet, installWallet } from "./helpers";

test("five main sections, More with its groups, pinning, and deep links", async ({ page, context }) => {
  await installWallet(context);
  await createWithWallet(page);

  const row = page.getByRole("tablist", { name: "Vault sections" });
  await expect(row.getByRole("tab")).toHaveText(["Memories", "Inbox", "AI self", "Apps", "Settings"]);

  // More shows the index in its four groups.
  await page.getByTestId("tab-more").click();
  const more = page.getByRole("navigation", { name: "More sections" });
  await expect(more.locator(".tab-group-label")).toHaveText(["Vault", "Self", "Access", "Others"]);
  await more.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page).toHaveURL(/#agents$/);
  await expect(row.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
  await expect(more).toHaveCount(0);

  // Pinned, Read log stays in the row, also after a reload.
  await page.getByTestId("tab-more").click();
  await more.getByRole("button", { name: "Pin Read log to the row" }).click();
  await page.getByTestId("tab-more").click();
  await expect(row.getByRole("tab", { name: "Read log" })).toBeVisible();
  await row.getByRole("tab", { name: "Memories" }).click();
  await expect(row.getByRole("tab", { name: "Agents" })).toHaveCount(0);
  await expect(row.getByRole("tab", { name: "Read log" })).toBeVisible();

  // A deep link opens its section directly.
  await page.goto("/");
  await page.goto("/vault#emergency");
  await page.getByTestId("method-wallet").click();
  await expect(row.getByRole("tab", { name: "Emergency" })).toHaveAttribute("aria-selected", "true");
  await expect(row.getByRole("tab", { name: "Read log" })).toBeVisible();

  // Unpinned, it goes back under More.
  await page.getByTestId("tab-more").click();
  await more.getByRole("button", { name: "Unpin Read log from the row" }).click();
  await page.getByTestId("tab-more").click();
  await row.getByRole("tab", { name: "Memories" }).click();
  await expect(row.getByRole("tab", { name: "Read log" })).toHaveCount(0);
});
