// The first five minutes: a new vault opens on the getting-started guide. The
// recovery phrase is checked on the way in, a ChatGPT export comes in, the guide
// keeps its place across a reload, makes a key for Claude Desktop with the
// exact file to paste, and finishes by itself when the app first reads.

import { expect, test } from "@playwright/test";
import { chatGptZip } from "../../packages/core/test/fixtures/exports";
import { connectMcp, createWithWallet, installWallet, textOf } from "./helpers";

const CANARY = "CANARY-guide-garden";

test("a new owner finishes the guide alone, and it resumes after a reload", async ({ page, context, baseURL }) => {
  await installWallet(context);
  await createWithWallet(page, { guide: true });

  const guide = page.getByTestId("guide");
  await expect(guide).toContainText("Getting started");
  await expect(page.getByTestId("guide-step-phrase")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("guide-step-import")).toHaveAttribute("data-current", "true");

  // The export is opened and encrypted in the browser.
  await page.getByTestId("guide-import-file").setInputFiles({ name: "chatgpt-export.zip", mimeType: "application/zip", buffer: Buffer.from(chatGptZip(CANARY)) });
  await expect(page.getByTestId("guide-step-import")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("guide-step-connect")).toHaveAttribute("data-current", "true");

  // A reload locks the vault; signed in again, the guide is where it was.
  await page.reload();
  await page.getByTestId("method-wallet").click();
  await expect(page.getByTestId("guide-step-connect")).toHaveAttribute("data-current", "true");

  await page.getByText("Claude Desktop", { exact: true }).click();
  await page.getByRole("button", { name: "Make a key for Claude Desktop" }).click();
  const appKey = (await page.getByTestId("guide-app-key").innerText()).trim();
  expect(appKey).toMatch(/^sigil_app\./);
  await expect(guide.locator("pre")).toContainText('"mcpServers"');
  await expect(guide).toContainText("claude_desktop_config.json");
  await page.getByRole("button", { name: "I added it: next step" }).click();
  await expect(page.getByTestId("guide-step-answer")).toHaveAttribute("data-current", "true");

  // The app asks; the guide sees the first read in the log and finishes.
  const mcp = await connectMcp(appKey, baseURL!);
  try {
    expect(textOf(await mcp.callTool({ name: "search_memories", arguments: { query: "garden" } }))).toContain("garden");
  } finally {
    await mcp.close();
  }
  await expect(guide).toContainText("You are set up", { timeout: 20_000 });
  await expect(page.getByTestId("guide-step-answer")).toHaveAttribute("data-state", "done");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(guide).toHaveCount(0);

  // It can be shown again from Settings.
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Show the guide again" }).click();
  await expect(page.getByTestId("guide")).toContainText("You are set up");
});

test("the recovery phrase must be typed back before the vault opens", async ({ page, context }) => {
  await installWallet(context);
  await page.goto("/vault");
  await page.getByTestId("method-wallet").click();
  await expect(page.getByTestId("recovery-phrase").locator("li")).toHaveCount(24);
  const phrase = (await page.getByTestId("recovery-phrase").locator("li").allInnerTexts()).map((w) => w.trim());
  await page.getByLabel("I have saved my recovery phrase somewhere safe.").check();
  const open = page.getByRole("button", { name: "Open my vault" });
  await expect(open).toBeDisabled();
  const inputs = page.getByTestId("phrase-check").locator("input[data-word]");
  await expect(inputs).toHaveCount(2);
  const [a, b] = await inputs.all();
  await a.fill(phrase[Number(await a.getAttribute("data-word")) - 1]);
  await b.fill("wrongword");
  await expect(page.getByTestId("phrase-check")).toContainText("That is not the word at that place");
  await expect(open).toBeDisabled();
  await b.fill(phrase[Number(await b.getAttribute("data-word")) - 1]);
  await expect(open).toBeEnabled();
  await open.click();
  await expect(page.getByTestId("guide")).toBeVisible();
  // Skipped as a whole, it stays closed.
  await page.getByRole("button", { name: "Skip the guide" }).click();
  await expect(page.getByTestId("guide")).toHaveCount(0);
});
