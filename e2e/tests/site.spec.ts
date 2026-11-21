// The public site around the vault: the menus, every page in them, the live
// numbers, the Import page handing a file to the vault, and the public proof
// checker verifying an entry copied out of a real read log.

import { expect, test } from "@playwright/test";
import { chatGptZip } from "../../packages/core/test/fixtures/exports";
import { navGroups } from "../../web/src/lib/site";
import { connectMcp, createWithWallet, fitsPhone, installWallet, textOf, openTab } from "./helpers";

const pages = navGroups.flatMap((g) => g.items);

test("the header menus open and lead to every page", async ({ page }) => {
  await page.goto("/");
  for (const group of navGroups) {
    const button = page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: group.label });
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    for (const item of group.items) {
      await expect(page.locator(`.nav-panel:not([hidden]) a[href="${item.href}"] .nav-panel-title`)).toHaveText(item.label);
    }
    await page.keyboard.press("Escape");
    await expect(button).toHaveAttribute("aria-expanded", "false");
  }

  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Product" }).click();
  await page.locator('.nav-panel:not([hidden]) a[href="/seals"]').click();
  await expect(page).toHaveURL(/\/seals$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("sealed into one fingerprint");
  await expect(page.locator(".nav-panel:not([hidden])")).toHaveCount(0);
});

test("every page in the menu answers with its own heading and no broken layout", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  expect(pages.length).toBe(26);
  for (const item of pages) {
    const res = await page.goto(item.href);
    // A link to another part of the page already open loads nothing new, so the address is asked for directly.
    expect(res ? res.status() : (await page.request.get(item.href)).status(), item.href).toBe(200);
    if (item.href !== "/vault") await expect(page.locator("h1"), item.href).toHaveCount(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${item.href} scrolls sideways`).toBeLessThanOrEqual(0);
  }
  expect(errors).toEqual([]);
});

test("the home page and the status page show live numbers from the server", async ({ page, request }) => {
  const stats = await (await request.get("/api/stats")).json();
  expect(Object.keys(stats).sort()).toEqual(["apps", "memories", "reads", "seals", "vaults"]);

  await page.goto("/");
  await expect(page.locator(".stat")).toHaveCount(4);
  await expect(page.locator(".stats")).toHaveAttribute("data-state", "ready");
  await expect(page.locator(".seal-card")).toContainText("This hour closes in");

  await page.goto("/status");
  await expect(page.locator(".status-banner")).toContainText("Everything is working");
  await expect(page.locator(".status-row")).toHaveCount(4);
  await expect(page.locator(".status-row", { hasText: "Seal job" })).toContainText("Working");
  await expect(page.locator(".status-row", { hasText: "Seals on chain" })).toContainText("Switched off");
});

test("a file dropped on the Import page is opened by the vault", async ({ page, context }) => {
  await installWallet(context);
  await createWithWallet(page);

  // A fresh page load locks the vault; the file waits while it is unlocked.
  await page.goto("/import");
  await page.getByTestId("import-drop-file").setInputFiles({ name: "chatgpt-export.zip", mimeType: "application/zip", buffer: Buffer.from(chatGptZip("site-e2e")) });
  await expect(page).toHaveURL(/\/vault#import$/);
  await page.getByRole("heading", { name: "Unlock your vault" }).waitFor();
  await page.getByTestId("method-wallet").click();
  await expect(page.getByTestId("import-preview")).toContainText("ChatGPT export: 2 items found");
  await page.getByRole("button", { name: "Import 2 memories" }).click();
  await expect(page.getByTestId("import-done")).toContainText("Imported 2 memories into ChatGPT");

  // Something that is not an export is refused on the page itself.
  await page.goto("/import");
  await page.getByTestId("import-drop-file").setInputFiles({ name: "holiday.png", mimeType: "image/png", buffer: Buffer.from("not an export") });
  await expect(page.locator(".import-drop [role=alert]")).toContainText("That is not an export file");
  await expect(page).toHaveURL(/\/import$/);
});

test("an entry copied from the read log verifies on the public pages", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await installWallet(context);
  await createWithWallet(page);

  await page.getByRole("button", { name: "Write a memory" }).click();
  await page.getByLabel("Title").fill("Harbour notes");
  await page.getByLabel("Memory", { exact: true }).fill("The ferry leaves at seven.");
  await page.getByRole("button", { name: "Save memory" }).click();
  await expect(page.locator(".memory-item-title", { hasText: "Harbour notes" })).toBeVisible();

  await openTab(page, "Apps");
  await page.getByRole("button", { name: "Connect your first app" }).click();
  await page.getByLabel("Notes").check();
  await page.getByRole("button", { name: "Create app key" }).click();
  const appKey = (await page.getByTestId("app-key").innerText()).trim();
  await page.getByLabel("I have copied the app key.").check();
  await page.getByRole("button", { name: "Done" }).click();

  const mcp = await connectMcp(appKey, baseURL!);
  expect(textOf(await mcp.callTool({ name: "search_memories", arguments: { query: "harbour" } }))).toContain("Harbour notes");
  await mcp.close();

  await openTab(page, "Read log");
  await page.waitForTimeout(5_000);
  await page.getByRole("button", { name: "Refresh" }).click();
  const row = page.locator(".log-row").first();
  await expect(row).toHaveAttribute("data-sealed", "true");
  await row.getByRole("button", { name: "Verify" }).click();
  await expect(row.getByTestId("verified")).toContainText("Verified: part of the seal for");
  await row.getByRole("button", { name: "Copy entry" }).click();
  await expect(row.getByRole("button", { name: "Copied" })).toBeVisible();
  const entryJson = await page.evaluate(() => navigator.clipboard.readText());
  const entry = JSON.parse(entryJson) as { hour: number; salt: string };
  expect(entry.salt).toMatch(/^[0-9a-f]{64}$/);

  // The public counters now include this vault, its memory and its read.
  const stats = await (await page.request.get("/api/stats")).json();
  expect(stats.vaults).toBeGreaterThanOrEqual(1);
  expect(stats.reads).toBeGreaterThanOrEqual(1);
  expect(stats.seals).toBeGreaterThanOrEqual(1);

  // ---- the whole entry, on the Verify page
  await page.goto("/verify");
  await page.getByRole("button", { name: "A log entry" }).click();
  await page.getByLabel("Entry from your read log").fill(entryJson);
  await page.getByRole("button", { name: "Check", exact: true }).click();
  const result = page.getByTestId("verifier-result");
  await expect(result).toHaveAttribute("data-ok", "true");
  await expect(result).toContainText("This fingerprint is part of the seal");
  const fingerprint = (await result.locator(".proof-steps li").first().locator("code").innerText()).trim();
  const root = (await result.locator('.proof-steps li[data-final="true"] code').innerText()).trim();
  expect(fingerprint).toMatch(/^0x[0-9a-f]{64}$/);

  // A doctored entry no longer leads to the seal.
  await page.getByLabel("Entry from your read log").fill(JSON.stringify({ ...JSON.parse(entryJson), count: 99 }));
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(result).toHaveAttribute("data-ok", "false");

  // ---- by hand, with nothing sent to the server
  const proof = await (await page.request.get(`/api/seals/${entry.hour}/proof?leaf=${fingerprint}`)).json();
  expect(proof.root).toBe(root);
  await page.getByRole("button", { name: "A proof by hand" }).click();
  await page.getByLabel("Seal root").fill(root);
  await page.getByLabel("Fingerprint", { exact: true }).fill(fingerprint);
  await page.getByLabel("Proof, one fingerprint per line").fill((proof.proof as string[]).join("\n"));
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(result).toHaveAttribute("data-ok", "true");
  await expect(result).toContainText("The proof leads to this root");

  // ---- the fingerprint alone, on the Seals page, which also lists the seal
  await page.goto("/seals");
  await expect(page.locator(".seal-card")).toContainText("Latest seal");
  await expect(page.locator(".seal-row").first()).toBeVisible();
  await page.getByLabel("Seal", { exact: true }).selectOption(String(entry.hour));
  await page.getByLabel("Fingerprint", { exact: true }).fill(fingerprint);
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByTestId("verifier-result")).toHaveAttribute("data-ok", "true");

  await page.getByLabel("Fingerprint", { exact: true }).fill(`0x${"ab".repeat(32)}`);
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByTestId("verifier-result")).toContainText("That fingerprint is not part of this seal");
});

test("the open standard reads as one document: its facts, numbered contents and every part, on a phone too", async ({ page }) => {
  await page.goto("/spec");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("The Sigil open standard");
  await expect(page.locator(".spec-sheet")).toContainText("Version1.3.0");
  const contents = page.getByRole("navigation", { name: "Parts of the standard" });
  await expect(contents.locator(".spec-index > li")).toHaveCount(14);
  await expect(page.locator(".spec-part")).toHaveCount(13);
  // A link in the contents and a link between parts both land on a heading of this page.
  await contents.getByRole("link", { name: "2. Keys, envelopes and sealed boxes" }).click();
  await expect(page).toHaveURL(/\/spec#keys$/);
  await expect(page.locator("#keys h2")).toBeInViewport();
  for (const href of await page.locator('.spec-doc a[href^="#"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!))) {
    expect(await page.locator(`[id="${href.slice(1)}"]`).count(), href).toBe(1);
  }
  await fitsPhone(page, "The open standard");
});
