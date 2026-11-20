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
  ["import", "/import"],
  ["apps", "/apps"],
  ["seals", "/seals"],
  ["how-it-works", "/how-it-works"],
  ["security", "/security"],
  ["threat-model", "/threat-model"],
  ["privacy", "/privacy"],
  ["status", "/status"],
  ["docs", "/docs"],
  ["api-reference", "/docs/api"],
  ["connector", "/connector"],
  ["verify", "/verify"],
  ["open-source", "/open-source"],
  ["ai-self", "/ai-self"],
  ["roadmap", "/roadmap"],
  ["changelog", "/changelog"],
  ["terms", "/terms"],
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
    // Things rise in as they enter the screen; let them settle.
    await page.waitForTimeout(1500);
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
      // The hero piece walks through its readers; shoot it on the third, where some lines are locked.
      if (name === "home") await page.waitForTimeout(9_500);
      await shoot(page, `${name}-${vp}`);
    }
    if (vp === "phone") {
      await page.goto("/");
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, `menu-phone-open.png`) });
    } else {
      // Each header menu, open. With reduced motion, so the hero piece behind it rests on one frame.
      const still = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      const menuPage = await still.newPage();
      await menuPage.goto("/");
      await menuPage.evaluate(() => document.fonts.ready);
      await menuPage.waitForTimeout(1500);
      for (const group of ["Product", "Trust", "Developers", "Vision"]) {
        await menuPage.getByRole("navigation", { name: "Main" }).getByRole("button", { name: group }).click();
        await menuPage.waitForTimeout(400);
        await menuPage.screenshot({ path: path.join(OUT, `menu-desktop-${group.toLowerCase()}.png`) });
      }
      await still.close();
    }
    await context.close();
  });
}

// The page ground in motion: the drifting light, the engraving it shows, and the light under the pointer.
test("backdrop in motion", async ({ browser }) => {
  const { context, page } = await newPage(browser, "desktop");
  await page.goto("/security");
  await page.evaluate(() => document.fonts.ready);
  let n = 0;
  for (const wait of [2500, 9000, 9000]) {
    await page.waitForTimeout(wait);
    await page.screenshot({ path: path.join(OUT, `backdrop-frame-${++n}.png`) });
  }
  for (const [x, y] of [[1100, 520], [380, 700]]) {
    await page.mouse.move(x, y, { steps: 20 });
    await page.waitForTimeout(2200);
    await page.screenshot({ path: path.join(OUT, `backdrop-frame-${++n}.png`) });
  }
  await context.close();

  // With reduced motion: one finished frame, nothing moves.
  const still = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const stillPage = await still.newPage();
  await stillPage.goto("/security");
  await stillPage.evaluate(() => document.fonts.ready);
  await stillPage.waitForTimeout(2500);
  await stillPage.screenshot({ path: path.join(OUT, `backdrop-reduced-motion.png`) });
  await still.close();
});

// The three hero directions (?hero=a|b|c): desktop and phone views, a few moments
// of the motion, and the still frame shown with reduced motion.
const HERO_MOMENTS = {
  a: [1000, 3600, 6200, 9300, 11300, 15000],
  b: [1500, 3650, 6000, 8450, 11000, 16000],
  c: [500, 1200, 2200, 6000],
} as const;

for (const hero of ["a", "b", "c"] as const) {
  test(`hero ${hero}`, async ({ browser }) => {
    const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `hero-${hero}-${name}.png`) });

    const desktop = await newPage(browser, "desktop");
    await desktop.page.goto(`/?hero=${hero}`);
    await desktop.page.evaluate(() => document.fonts.ready);
    const start = Date.now();
    let n = 0;
    for (const at of HERO_MOMENTS[hero]) {
      await desktop.page.waitForTimeout(Math.max(0, at - (Date.now() - start)));
      await shot(desktop.page, `frame-${++n}`);
    }
    if (hero === "c") {
      // The light follows the pointer.
      for (const [x, y] of [[260, 300], [1380, 640]]) {
        await desktop.page.mouse.move(x, y, { steps: 12 });
        await desktop.page.waitForTimeout(2600);
        await shot(desktop.page, `frame-${++n}`);
      }
    }
    await desktop.context.close();

    // The settled view at both sizes: reduced motion holds each piece on its telling frame.
    for (const vp of Object.keys(VIEWPORTS) as Vp[]) {
      const { width, height, ...rest } = VIEWPORTS[vp];
      const context = await browser.newContext({ viewport: { width, height }, ...rest, reducedMotion: hero === "c" ? "no-preference" : "reduce" });
      const page = await context.newPage();
      await page.goto(`/?hero=${hero}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(hero === "c" ? 6000 : 1200);
      await shot(page, vp);
      if (vp === "phone" && hero !== "c") {
        await page.evaluate(() => {
          const top = document.querySelector(".hero-visual")!.getBoundingClientRect().top + window.scrollY;
          window.scrollTo({ top: top - 84, behavior: "instant" as ScrollBehavior });
        });
        await page.waitForTimeout(400);
        await shot(page, "phone-piece");
      }
      await context.close();
    }

    const still = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const stillPage = await still.newPage();
    await stillPage.goto(`/?hero=${hero}`);
    await stillPage.evaluate(() => document.fonts.ready);
    await stillPage.waitForTimeout(1500);
    await shot(stillPage, "reduced-motion");
    await still.close();
  });
}

// The share image is not a screenshot: web/scripts/share-image.mjs draws it.

test("vault states", async ({ browser, baseURL }) => {
  test.setTimeout(900_000);
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
    await page.getByRole("button", { name: "Import something else" }).click();
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
