// The whole first build, end to end, in a real browser against the real server:
// sign up, write, import, connect an app over MCP, read, check the log and its
// seal, revoke, and see the read fail. Nothing readable may leave the browser.

import { expect, test } from "@playwright/test";
import { chatGptZip, claudeZip } from "../../packages/core/test/fixtures/exports";
import { connectMcp, createWithWallet, installWallet, recordBodies, textOf } from "./helpers";

const CANARY = "CANARY-PLAINTEXT-e2e-91c4";

test("sign up, import, connect over MCP, read, revoke, read fails", async ({ page, context, baseURL }) => {
  await installWallet(context);
  const sent = recordBodies(page);

  // ---- sign up with a wallet
  const phrase = await createWithWallet(page);
  expect(phrase.split(" ")).toHaveLength(24);
  await expect(page.getByText("Your vault is empty")).toBeVisible();

  // ---- write a memory
  await page.getByRole("button", { name: "Write a memory" }).click();
  await page.getByLabel("Title").fill(`Private note ${CANARY}`);
  await page.getByLabel("Memory", { exact: true }).fill(`My locker code is 4417. ${CANARY}`);
  await page.getByLabel("Tags").fill("personal, codes");
  await page.getByRole("button", { name: "Save memory" }).click();
  await expect(page.locator(".memory-item-title", { hasText: "Private note" })).toBeVisible();

  // ---- import a ChatGPT export and a Claude export
  await page.getByRole("tab", { name: "Import" }).click();
  await page.getByTestId("import-file").setInputFiles({ name: "chatgpt-export.zip", mimeType: "application/zip", buffer: Buffer.from(chatGptZip(CANARY)) });
  await expect(page.getByTestId("import-preview")).toContainText("ChatGPT export: 2 items found");
  await page.getByRole("button", { name: "Import 2 memories" }).click();
  await expect(page.getByTestId("import-done")).toContainText("Imported 2 memories into ChatGPT");

  await page.getByRole("button", { name: "Import something else" }).click();
  await page.getByTestId("import-file").setInputFiles({ name: "claude-export.zip", mimeType: "application/zip", buffer: Buffer.from(claudeZip(CANARY)) });
  await expect(page.getByTestId("import-preview")).toContainText("Claude export: 5 items found");
  await page.getByRole("button", { name: "Import 5 memories" }).click();
  await expect(page.getByTestId("import-done")).toContainText("Imported 5 memories into Claude");

  // Importing the same file again finds nothing new.
  await page.getByRole("button", { name: "Import something else" }).click();
  await page.getByTestId("import-file").setInputFiles({ name: "chatgpt-export.zip", mimeType: "application/zip", buffer: Buffer.from(chatGptZip(CANARY)) });
  await expect(page.getByTestId("import-preview")).toContainText("Everything in this file is already in your vault.");

  // ---- search in the dashboard (client side)
  await page.getByRole("tab", { name: "Memories" }).click();
  await page.getByLabel("Search memories").fill("garden");
  await expect(page.locator(".memory-item-title")).toHaveText(["Planning a garden"]);
  await page.getByLabel("Search memories").fill("");
  await expect(page.locator(".memory-item")).toHaveCount(8);

  // ---- connect an app that may read only the ChatGPT folder
  await page.getByRole("tab", { name: "Apps" }).click();
  await page.getByRole("button", { name: "Connect your first app" }).click();
  await page.getByLabel("ChatGPT").check();
  await expect(page.getByText("This app will be able to read ChatGPT. It will not see Notes and Claude.")).toBeVisible();
  await page.getByRole("button", { name: "Create app key" }).click();
  const appKey = (await page.getByTestId("app-key").innerText()).trim();
  expect(appKey).toMatch(/^sigil_app\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  await expect(page.locator(".code-block")).toContainText('"SIGIL_APP_KEY"');
  await page.getByLabel("I have copied the app key.").check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".app-row", { hasText: "Claude Desktop" })).toContainText("Active");

  // ---- the connector, over MCP stdio, exactly as Claude Desktop would start it
  const mcp = await connectMcp(appKey, baseURL!);
  const tools = await mcp.listTools();
  expect(tools.tools.map((t) => t.name).sort()).toEqual(["get_profile", "list_folders", "propose_memory", "read_memory", "search_memories"]);

  expect(textOf(await mcp.callTool({ name: "list_folders", arguments: {} }))).toContain("- ChatGPT (2 memories)");

  const found = textOf(await mcp.callTool({ name: "search_memories", arguments: { query: "garden" } }));
  expect(found).toContain("Planning a garden");
  const id = /id: ([A-Za-z0-9_-]+)/.exec(found)![1];

  const full = textOf(await mcp.callTool({ name: "read_memory", arguments: { id } }));
  expect(full).toContain("# Planning a garden");
  expect(full).toContain(`Which vegetables grow in shade? ${CANARY}`);

  // Folders that were not granted stay invisible.
  expect(textOf(await mcp.callTool({ name: "search_memories", arguments: { query: "sail" } }))).toBe('No memories match "sail".');
  expect(textOf(await mcp.callTool({ name: "search_memories", arguments: { query: "locker" } }))).toBe('No memories match "locker".');

  // ---- the read log shows it, and the seal verifies in the browser
  await page.getByRole("tab", { name: "Read log" }).click();
  await expect(page.locator(".log-row", { hasText: 'Read "Planning a garden"' })).toBeVisible();
  await expect(page.locator(".log-row")).toHaveCount(5);
  await expect(page.locator(".log-row").first()).toContainText("Claude Desktop");

  // Seal periods are 4 seconds in this test; wait for the period to end, then refresh.
  await page.waitForTimeout(5_000);
  await page.getByRole("button", { name: "Refresh" }).click();
  const readRow = page.locator(".log-row", { hasText: 'Read "Planning a garden"' });
  await expect(readRow).toHaveAttribute("data-sealed", "true");
  await readRow.getByRole("button", { name: "Verify" }).click();
  await expect(readRow.getByTestId("verified")).toContainText("Verified: part of the seal for");

  // ---- revoke, and the very next read fails
  await page.getByRole("tab", { name: "Apps" }).click();
  await page.locator(".app-row", { hasText: "Claude Desktop" }).getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("button", { name: "Revoke access" }).click();
  await expect(page.locator(".app-row", { hasText: "Claude Desktop" })).toContainText("Revoked");

  const afterRevoke = await mcp.callTool({ name: "read_memory", arguments: { id } });
  expect(afterRevoke.isError).toBe(true);
  expect(textOf(afterRevoke)).toContain("revoked");
  const searchAfter = await mcp.callTool({ name: "search_memories", arguments: { query: "garden" } });
  expect(searchAfter.isError).toBe(true);
  await mcp.close();

  // ---- lock, unlock with the wallet, everything is still there
  await page.reload();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  await page.getByTestId("method-wallet").click();
  await expect(page.getByRole("heading", { name: "Your vault" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Apps" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Memories" }).click();
  await expect(page.locator(".memory-item")).toHaveCount(8);

  // ---- export everything, decrypted on the device
  await page.getByRole("tab", { name: "Settings" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download everything" }).click()]);
  const exported = JSON.parse(await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8")));
  expect(exported.format).toBe("sigil-export");
  expect(exported.memories).toHaveLength(8);
  expect(exported.readLog.length).toBeGreaterThanOrEqual(5);

  // ---- nothing readable ever left the browser
  const wire = sent.join("\n");
  for (const secret of [CANARY, "locker code", "Planning a garden", "Learning to sail", "Which vegetables", "personal", phrase, phrase.split(" ").slice(0, 3).join(" ")]) {
    expect(wire, `"${secret}" was sent to the server`).not.toContain(secret);
  }
  expect(wire).not.toContain(appKey.split(".")[2]);
});

test("delete account removes the vault", async ({ page, context }) => {
  await installWallet(context);
  await createWithWallet(page);
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByLabel('Type "delete my vault" to confirm').fill("delete my vault");
  await page.getByRole("button", { name: "Delete everything" }).click();
  await expect(page.getByRole("heading", { name: "Create your vault" })).toBeVisible();
  // The wallet no longer opens anything.
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByTestId("method-wallet").click();
  await expect(page.locator(".notice-error")).toContainText("No vault opens with this wallet");
});
