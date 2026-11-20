// Agents get their own memory: an agent vault made in the browser, used by a
// real MCP client through the built connector. It remembers into its own
// folder, recalls what it was given, leaves a handoff note its next session
// picks up, and writes into a team space it was added to.

import { expect, test } from "@playwright/test";
import { connectMcp, createWithWallet, installWallet, recordBodies, textOf, writeMemory } from "./helpers";

const CANARY = "CANARY-agent-e2e-77c0";

test("an agent vault: remember, recall, a handoff note and a team space, all in the read log", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext();
  await installWallet(ctx);
  const page = await ctx.newPage();
  const wire = recordBodies(page);
  await createWithWallet(page);
  await writeMemory(page, { title: "Style guide", body: "Tabs, not spaces." });

  await page.getByRole("tab", { name: "Agents" }).click();
  await page.getByRole("button", { name: "Make the first agent vault" }).click();
  const form = page.getByRole("form", { name: "Make an agent vault" });
  await form.getByLabel("Client").selectOption("cursor");
  await form.getByLabel("Access to Notes").selectOption("read");
  await form.getByRole("button", { name: "Make the agent key" }).click();
  const appKey = (await page.getByTestId("app-key").innerText()).trim();
  await page.getByLabel("I have copied the agent key.").check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".agent-row")).toContainText("Own folder Cursor memory");

  const mcp = await connectMcp(appKey, baseURL!);
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  expect(tools).toEqual(expect.arrayContaining(["remember", "recall", "forget", "leave_handoff", "pick_up_handoffs"]));
  expect(textOf(await mcp.callTool({ name: "remember", arguments: { title: "Parser state", body: `Half done. ${CANARY}` } }))).toContain("in Cursor memory");
  expect(textOf(await mcp.callTool({ name: "remember", arguments: { title: "x", body: "y", folder: "Notes" } }))).toContain("may not write");
  const recalled = textOf(await mcp.callTool({ name: "recall", arguments: { query: "style guide" } }));
  expect(recalled).toContain("Tabs, not spaces.");
  expect(textOf(await mcp.callTool({ name: "forget", arguments: { ids: ["abcdefgh1234"] } }))).toContain("may not forget");
  expect(textOf(await mcp.callTool({ name: "leave_handoff", arguments: { text: "Next: wire the parser into the CLI." } }))).toBe("Left a note for this agent's next session.");
  await mcp.close();

  // The next session picks the note up, once.
  const next = await connectMcp(appKey, baseURL!);
  expect(textOf(await next.callTool({ name: "pick_up_handoffs", arguments: {} }))).toContain("Next: wire the parser into the CLI.");
  expect(textOf(await next.callTool({ name: "pick_up_handoffs", arguments: {} }))).toBe("No handoff notes are waiting.");

  // The owner sees what the agent remembered and the note it left.
  await page.reload();
  await page.getByTestId("method-wallet").click();
  await page.getByRole("tab", { name: "Memories" }).click();
  await page.locator(".memory-item", { hasText: "Parser state" }).click();
  await expect(page.getByLabel("Memory", { exact: true })).toHaveValue(`Half done. ${CANARY}`);
  await page.getByRole("tab", { name: "Agents" }).click();
  await page.locator(".agent-row").getByRole("button", { name: "Handoff notes" }).click();
  await expect(page.getByTestId("agent-notes")).toContainText("Next: wire the parser into the CLI.");

  // A team space: the agent is added and writes into it.
  await page.getByRole("button", { name: "New space" }).click();
  const space = page.getByRole("form", { name: "New space" });
  await space.getByLabel("Name of the space").fill("Launch");
  await space.getByLabel("Your name in it").fill("Sam");
  await space.getByRole("button", { name: "Make the space" }).click();
  const card = page.locator(".space-card", { hasText: "Launch" });
  await card.getByRole("button", { name: "Add an agent" }).click();
  await card.getByRole("form", { name: "Add an agent to Launch" }).getByRole("button", { name: "Add" }).click();
  await expect(card.locator(".space-member", { hasText: "Cursor" })).toContainText("Reads and writes");
  expect(textOf(await next.callTool({ name: "remember", arguments: { title: "Launch checklist", body: "Ship notes on Friday.", folder: "Launch" } }))).toContain("the space Launch");
  await next.close();
  await page.reload();
  await page.getByTestId("method-wallet").click();
  await page.getByRole("tab", { name: "Agents" }).click();
  await expect(page.locator(".space-card", { hasText: "Launch" }).locator(".space-memories")).toContainText("Launch checklist");

  await page.getByRole("tab", { name: "Read log" }).click();
  await expect(page.locator(".log-row", { hasText: 'Remembered "Parser state"' })).toBeVisible();
  await expect(page.locator(".log-row", { hasText: "Left a handoff note" })).toBeVisible();
  await expect(page.locator(".log-row", { hasText: "Wrote 1 memory to the space Launch" })).toBeVisible();
  expect(wire.join("\n")).not.toContain(CANARY);
  await ctx.close();
});
