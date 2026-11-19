import { test, type Browser, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chatGptZip, claudeZip } from "../../packages/core/test/fixtures/exports";
import { connectMcp, installWallet, ROOT } from "../tests/helpers";

const OUT = path.join(ROOT, "docs/screenshots");
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
} as const;
type Vp = keyof typeof VIEWPORTS;

const PAGES = [
  ["home", "/"],
  ["how-it-works", "/how-it-works"],
  ["security", "/security"],
  ["docs", "/docs"],
  ["roadmap", "/roadmap"],
  ["terms", "/terms"],
  ["privacy", "/privacy"],
  ["not-found", "/does-not-exist"],
] as const;

async function newPage(browser: Browser, vp: Vp) {
  const { width, height, ...rest } = VIEWPORTS[vp];
  const context = await browser.newContext({ viewport: { width, height }, ...rest, reducedMotion: "no-preference" });
  return { context, page: await context.newPage() };
}

/** Screen-sized shots at the top, middle and bottom (as many as the page is long). */
async function shoot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  const h = page.viewportSize()!.height;
  const stops: [string, number][] = [["top", 0]];
  if (total > h * 2.2) stops.push(["middle", Math.round((total - h) / 2)]);
  if (total > h * 1.15) stops.push(["bottom", total - h]);
  for (const [label, y] of stops) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" as ScrollBehavior }), y);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, `${name}-${label}.png`) });
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
}

for (const vp of Object.keys(VIEWPORTS) as Vp[]) {
  test(`pages at ${vp}`, async ({ browser }) => {
    const { context, page } = await newPage(browser, vp);
    for (const [name, url] of PAGES) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      // The hero seal is engraved over a few seconds; shoot it once it is whole.
      if (name === "home") await page.waitForTimeout(9_000);
      await shoot(page, `${name}-${vp}`);
    }
    if (vp === "phone") {
      await page.goto("/");
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.screenshot({ path: path.join(OUT, `menu-phone-open.png`) });
    }
    await context.close();
  });
}

// A few moments of the hero motion, so it can be judged from stills.
test("hero motion frames", async ({ browser }) => {
  const { context, page } = await newPage(browser, "desktop");
  await page.goto("/");
  await page.locator('.seal[data-live="true"]').waitFor();
  const start = Date.now();
  const moments = [600, 1800, 3000, 4400, 6000, 8000, 12000, 16500];
  for (const [i, at] of moments.entries()) {
    await page.waitForTimeout(Math.max(0, at - (Date.now() - start)));
    await page.screenshot({ path: path.join(OUT, `hero-${String(i + 1).padStart(2, "0")}.png`) });
  }
  await context.close();
  const still = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const stillPage = await still.newPage();
  await stillPage.goto("/");
  await stillPage.locator('.seal[data-live="true"]').waitFor();
  await stillPage.waitForTimeout(500);
  await stillPage.screenshot({ path: path.join(OUT, "hero-reduced-motion.png") });
  await still.close();
});

test("vault states", async ({ browser, baseURL }) => {
  for (const vp of Object.keys(VIEWPORTS) as Vp[]) {
    const { context, page } = await newPage(browser, vp);
    await installWallet(context);
    const shot = (name: string) => shoot(page, `vault-${name}-${vp}`);

    await page.goto("/vault");
    await page.getByRole("button", { name: "Create a vault" }).waitFor();
    await shot("create");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByTestId("method-phrase").click();
    await shot("signin");
    await page.getByRole("button", { name: "Create a vault" }).click();

    await page.getByTestId("method-wallet").click();
    await page.getByTestId("recovery-phrase").waitFor();
    await shot("phrase");
    await page.getByLabel("I have saved my recovery phrase somewhere safe.").check();
    await page.getByRole("button", { name: "Open my vault" }).click();
    await page.getByText("Your vault is empty").waitFor();
    await shot("memories-empty");

    await page.getByRole("tab", { name: "Apps" }).click();
    await shot("apps-empty");
    await page.getByRole("tab", { name: "Read log" }).click();
    await page.getByText("No app has read your vault yet").waitFor();
    await shot("log-empty");

    await page.getByRole("tab", { name: "Import" }).click();
    await shot("import");
    await page.getByTestId("import-file").setInputFiles({ name: "chatgpt.zip", mimeType: "application/zip", buffer: Buffer.from(chatGptZip()) });
    await page.getByTestId("import-preview").waitFor();
    await shot("import-preview");
    await page.getByRole("button", { name: /^Import \d/ }).click();
    await page.getByTestId("import-done").waitFor();
    await shot("import-done");
    await page.getByRole("button", { name: "Import another file" }).click();
    await page.getByTestId("import-file").setInputFiles({ name: "claude.zip", mimeType: "application/zip", buffer: Buffer.from(claudeZip()) });
    await page.getByRole("button", { name: /^Import \d/ }).click();
    await page.getByTestId("import-done").waitFor();

    await page.getByRole("tab", { name: "Memories" }).click();
    await page.getByRole("button", { name: "New memory" }).click();
    await page.getByLabel("Title").fill("How I like answers");
    await page.getByLabel("Memory", { exact: true }).fill("Short first, details after. Metric units. Examples in TypeScript when there is code.");
    await page.getByLabel("Tags").fill("preferences, writing");
    await page.getByRole("button", { name: "Save memory" }).click();
    await page.locator(".memory-item", { hasText: "How I like answers" }).waitFor();
    await shot("memories");
    await page.getByRole("button", { name: "New memory" }).click();
    await shot("memories-new");

    await page.getByRole("tab", { name: "Folders" }).click();
    await page.getByLabel("New folder").fill("Health");
    await page.getByRole("button", { name: "Add folder" }).click();
    await page.locator(".list-row", { hasText: "Health" }).waitFor();
    await shot("folders");

    await page.getByRole("tab", { name: "Apps" }).click();
    await page.getByRole("button", { name: "Connect your first app" }).click();
    await page.getByLabel("ChatGPT").check();
    await page.getByLabel("Notes").check();
    await shot("apps-connect");
    await page.getByRole("button", { name: "Create app key" }).click();
    const appKey = (await page.getByTestId("app-key").innerText()).trim();
    await shot("apps-key");
    await page.getByLabel("I have copied the app key.").check();
    await page.getByRole("button", { name: "Done" }).click();
    await page.locator(".app-row").first().waitFor();
    await shot("apps");

    const mcp = await connectMcp(appKey, baseURL!);
    await mcp.callTool({ name: "list_folders", arguments: {} });
    const found = await mcp.callTool({ name: "search_memories", arguments: { query: "garden" } });
    const id = /id: ([A-Za-z0-9_-]+)/.exec(JSON.stringify(found))![1];
    await mcp.callTool({ name: "read_memory", arguments: { id } });
    await mcp.callTool({ name: "search_memories", arguments: { query: "answers" } });
    await mcp.close();

    await page.getByRole("tab", { name: "Read log" }).click();
    await page.locator(".log-row").first().waitFor();
    await shot("log-waiting");
    // One-minute seal periods for the screenshots: wait for the minute to end.
    await page.waitForTimeout(62_000);
    await page.getByRole("button", { name: "Refresh" }).click();
    await page.locator('.log-row[data-sealed="true"]').first().waitFor();
    await page.locator(".log-row", { hasText: "Read" }).first().getByRole("button", { name: "Verify" }).click();
    await page.getByTestId("verified").first().waitFor();
    await shot("log");

    await page.getByRole("tab", { name: "Settings" }).click();
    await shot("settings");

    await page.reload();
    await page.getByRole("heading", { name: "Unlock your vault" }).waitFor();
    await shot("unlock");
    await context.close();
  }
});
