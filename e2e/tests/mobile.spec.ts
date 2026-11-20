// The vault at 375 pixels wide: every tab, the new forms open, the capture
// screen and the device code, with no sideways scrolling anywhere.

import { expect, test, type Page } from "@playwright/test";
import { createWithWallet, installWallet, writeMemory } from "./helpers";

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

  const tabs = ["Memories", "Inbox", "AI self", "Meet", "Review", "Timeline", "Self card", "Folders", "Apps", "Agents", "Devices", "Legacy", "Proof", "Read log", "Import", "Sync", "Settings"];
  for (const name of tabs) {
    await page.getByRole("tab", { name }).click();
    await expect(page.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
    await noSideScroll(page, name);
  }

  // The new forms, open.
  await page.getByRole("tab", { name: "Legacy" }).click();
  await page.getByRole("button", { name: "Add by invite link" }).click();
  await noSideScroll(page, "Legacy editor");
  await page.getByRole("tab", { name: "Agents" }).click();
  await page.getByRole("button", { name: "Make the first agent vault" }).click();
  await page.getByRole("button", { name: "New space" }).click();
  await noSideScroll(page, "Agents forms");

  await page.goto("/capture");
  await expect(page.getByRole("heading", { name: "Into your inbox" })).toBeVisible();
  await noSideScroll(page, "Quick capture");

  const fresh = await browser.newContext({ viewport: { width: WIDTH, height: 812 }, isMobile: true, hasTouch: true });
  const phone = await fresh.newPage();
  await phone.goto("/vault");
  await phone.getByRole("button", { name: "Add this device" }).click();
  await expect(phone.getByTestId("pair-code")).toBeVisible();
  await noSideScroll(phone, "Add this device");
  await fresh.close();
  await ctx.close();
});
