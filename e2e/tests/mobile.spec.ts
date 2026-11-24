// The vault at 375 pixels wide: every tab, the new forms open, the capture
// screen and the device code, with no sideways scrolling anywhere.

import { expect, test, type Page } from "@playwright/test";
import { createWithWallet, installWallet, writeMemory, openTab } from "./helpers";

const WIDTH = 375;

async function noSideScroll(page: Page, where: string) {
  const over = await page.evaluate(() => {
    const doc = document.documentElement;
    const wide = [...document.querySelectorAll<HTMLElement>(".tab-panel *, .vault-gate *, .capture *")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        // Elements inside a horizontal scroller (the tab strip, code blocks, tables) may run wider.
        return r.right > window.innerWidth + 1 && !el.closest(".tabs, pre, .table-wrap, .code-block");
      })
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`);
    return { scroll: doc.scrollWidth, wide };
  });
  expect(over.wide, `${where}: elements past the right edge`).toEqual([]);
  expect(over.scroll, `${where}: page wider than the screen`).toBeLessThanOrEqual(WIDTH);
}

test("every vault screen fits a 375 pixel phone", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await installWallet(ctx);
  const page = await ctx.newPage();
  await createWithWallet(page);
  await writeMemory(page, { title: "A memory with a rather long title that has to wrap on a phone", body: "Text." });

  const tabs = [
    "Memories",
    "Ask",
    "Inbox",
    "AI self",
    "Work",
    "Identity",
    "Meet",
    "Agreements",
    "Review",
    "Timeline",
    "Self card",
    "Folders",
    "Apps",
    "Agents",
    "Shared memory",
    "Devices",
    "Legacy",
    "Proof",
    "Emergency",
    "Packs",
    "Read log",
    "Import",
    "Sync",
    "Storage",
    "Settings",
  ];
  for (const name of tabs) {
    await openTab(page, name);
    await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
    await noSideScroll(page, name);
  }

  // The new forms, open.
  await openTab(page, "Ask");
  await page.getByRole("button", { name: /All folders/ }).click();
  await page.getByLabel("Time").selectOption("custom");
  await page.getByLabel("Your question").fill("What is the long title about?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByTestId("ask-evidence")).toBeVisible();
  await page.locator(".ask-group .memory-item").first().click();
  await noSideScroll(page, "Ask with folders, dates and an answer");
  await openTab(page, "Agreements");
  await page.getByRole("button", { name: "Draft an agreement" }).click();
  await noSideScroll(page, "Agreement form");
  await openTab(page, "Identity");
  await page.getByRole("button", { name: "Make the self's key" }).click();
  await page.getByRole("button", { name: "Add a recipient" }).click();
  await page.getByRole("button", { name: "Add a contract" }).click();
  await noSideScroll(page, "Identity with rules");
  await openTab(page, "Emergency");
  await page.getByRole("button", { name: "Add a person" }).click();
  await noSideScroll(page, "Emergency card form");
  await openTab(page, "Legacy");
  await page.getByRole("button", { name: "Add by invite link" }).click();
  await noSideScroll(page, "Legacy editor");
  await openTab(page, "Agents");
  await page.getByRole("button", { name: "Make the first agent vault" }).click();
  await page.getByRole("button", { name: "New space" }).click();
  await noSideScroll(page, "Agents forms");
  await openTab(page, "Storage");
  await page.getByRole("button", { name: "Add storage" }).click();
  await page.getByLabel("Kind").selectOption("arweave");
  await noSideScroll(page, "Storage with a target form");
  await openTab(page, "Devices");
  await page.getByRole("button", { name: "Make a capture key" }).click();
  await expect(page.getByTestId("capture-made")).toBeVisible();
  for (const d of await page.locator(".shortcut-steps details").all()) await d.evaluate((el) => ((el as HTMLDetailsElement).open = true));
  await noSideScroll(page, "Devices with a capture key and its steps");

  await page.goto("/capture");
  await expect(page.getByRole("heading", { name: "Into your inbox" })).toBeVisible();
  await noSideScroll(page, "Quick capture");
  await page.goto("/vault/restore");
  await expect(page.getByRole("heading", { name: "Restore a vault" })).toBeVisible();
  await noSideScroll(page, "Restore a vault");

  const fresh = await browser.newContext({ viewport: { width: WIDTH, height: 812 }, isMobile: true, hasTouch: true });
  const phone = await fresh.newPage();
  await phone.goto("/vault");
  await phone.getByRole("button", { name: "Add this device" }).click();
  await expect(phone.getByTestId("pair-code")).toBeVisible();
  await noSideScroll(phone, "Add this device");
  await fresh.close();
  await ctx.close();
});
