// The memory inbox in a real browser: an app is allowed to suggest, the
// connector seals a suggestion on "this machine", the owner edits and approves
// it in the vault, and the app reads it back. Also the Self card through
// get_profile. Nothing readable leaves the browser.

import { expect, test } from "@playwright/test";
import { connectApp, connectMcp, createWithWallet, installWallet, recordBodies, textOf, writeMemory, openTab } from "./helpers";

const CANARY = "CANARY-inbox-e2e-5be0";

test("an app suggests a memory, the owner edits and approves it, the app reads it back", async ({ page, context, baseURL }) => {
  await installWallet(context);
  const sent = recordBodies(page);
  await createWithWallet(page);
  await writeMemory(page, { title: "Coffee", body: "Black, in the morning." });

  // Off by default: an app connected without the switch cannot suggest.
  const readOnlyKey = await connectApp(page, { name: "Read only", folders: ["Notes"] });
  const readOnly = await connectMcp(readOnlyKey, baseURL!);
  const refused = await readOnly.callTool({ name: "propose_memory", arguments: { title: "x", body: "y" } });
  expect(refused.isError).toBe(true);
  expect(textOf(refused)).toContain("may not suggest memories");
  await readOnly.close();

  const appKey = await connectApp(page, { name: "Claude Desktop", folders: ["Notes"], suggest: true });
  await expect(page.locator(".app-row").filter({ has: page.locator(".list-row-title", { hasText: "Claude Desktop" }) })).toContainText("May suggest memories");

  const mcp = await connectMcp(appKey, baseURL!);
  const proposed = await mcp.callTool({
    name: "propose_memory",
    arguments: { title: "Prefers green tea", body: `Green tea after lunch, no sugar. ${CANARY}`, tags: ["food"], folder: "Notes" },
  });
  expect(proposed.isError).toBeFalsy();
  expect(textOf(proposed)).toContain("only if they approve it");

  // The vault opens it with its own key.
  await page.reload();
  await page.getByTestId("method-wallet").click();
  await expect(page.getByRole("heading", { name: "Your vault", exact: true })).toBeVisible();
  const inboxTab = page.getByRole("tab", { name: /Inbox/ });
  await expect(inboxTab).toContainText("1");
  await inboxTab.click();
  const card = page.getByTestId("proposal");
  await expect(card).toContainText("Claude Desktop");
  await expect(card.getByLabel("Memory", { exact: true })).toHaveValue(`Green tea after lunch, no sugar. ${CANARY}`);
  await expect(card.getByLabel("Folder")).toHaveValue(/.+/);

  await card.getByLabel("Title").fill("Tea");
  await card.getByLabel("Tags").fill("food, tea");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Nothing waiting")).toBeVisible();

  await openTab(page, "Memories");
  await page.locator(".memory-item-title", { hasText: "Tea" }).click();
  await expect(page.locator(".editor-meta")).toContainText("Suggested by Claude Desktop");

  // The app finds what was approved, like any memory in a folder it may read.
  const found = textOf(await mcp.callTool({ name: "search_memories", arguments: { query: "tea" } }));
  expect(found).toContain("Tea");

  // The suggestion is in the read log.
  await openTab(page, "Read log");
  await expect(page.locator(".log-row", { hasText: "Suggested a memory to your inbox" })).toBeVisible();

  // A second suggestion is merged into an existing memory instead.
  await mcp.callTool({ name: "propose_memory", arguments: { title: "Coffee too", body: "A flat white on Fridays." } });
  await openTab(page, /Inbox/);
  await page.reload();
  await page.getByTestId("method-wallet").click();
  await openTab(page, /Inbox/);
  const second = page.getByTestId("proposal");
  await second.getByRole("button", { name: "Merge into a memory" }).click();
  await second.getByLabel("Find the memory").fill("coffee");
  await second.getByRole("radio", { name: "Coffee", exact: true }).check();
  await second.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(page.getByText("Nothing waiting")).toBeVisible();
  await openTab(page, "Memories");
  await page.locator(".memory-item-title", { hasText: "Coffee" }).click();
  await expect(page.getByLabel("Memory", { exact: true })).toHaveValue(/Black, in the morning\.[\s\S]*A flat white on Fridays\./);
  await mcp.close();

  // Nothing readable left the browser: the approved memory went up encrypted.
  const wire = sent.join("\n");
  for (const secret of [CANARY, "Green tea", "flat white"]) expect(wire, `"${secret}" was sent to the server`).not.toContain(secret);
});

test("the Self card is read first by an app that was given its folder", async ({ page, context, baseURL }) => {
  await installWallet(context);
  await createWithWallet(page);
  await openTab(page, "Self card");
  await page.getByLabel("Who I am").fill(`A boat builder. ${CANARY}`);
  await page.getByLabel("How I like answers").fill("Short, with metric units.");
  await page.getByLabel("Current projects").fill("A wooden dinghy");
  await page.getByRole("button", { name: "Save Self card" }).click();
  await expect(page.getByText("Your Self card is saved.")).toBeVisible();
  await expect(page.getByText("No app can read it yet.")).toBeVisible();

  const appKey = await connectApp(page, { name: "Cursor", folders: ["Self card"] });
  const mcp = await connectMcp(appKey, baseURL!);
  const card = textOf(await mcp.callTool({ name: "get_profile", arguments: {} }));
  expect(card).toContain("# Self card");
  expect(card).toContain(`A boat builder. ${CANARY}`);
  expect(card).toContain("## How I like answers\n\nShort, with metric units.");
  await mcp.close();

  await openTab(page, "Self card");
  await expect(page.getByText("Readable by Cursor.")).toBeVisible();
});
