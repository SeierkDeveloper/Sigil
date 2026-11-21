// Search by meaning on the device, in a real browser and in the connector,
// with the tiny model kept in the repository. Plus the Timeline and duplicates.

import { expect, test } from "@playwright/test";
import { connectApp, connectMcp, createWithWallet, installWallet, recordBodies, textOf, writeMemory, openTab } from "./helpers";

test("finds by meaning in the browser and in the connector, and the query never leaves the device", async ({ page, context, baseURL }) => {
  await installWallet(context);
  const sent = recordBodies(page);
  await createWithWallet(page);
  await writeMemory(page, { title: "Brakes squeak", body: "Booked the garage for Tuesday." });
  await writeMemory(page, { title: "Pasta night", body: "Fresh tomatoes and basil for dinner." });
  await writeMemory(page, { title: "Knots", body: "Learn the bowline before the boat trip." });

  await expect(page.locator(".search-mode")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await page.getByLabel("Search memories").fill("automobile");
  const hit = page.locator(".memory-item", { hasText: "Brakes squeak" });
  await expect(hit).toBeVisible();
  await expect(hit).toHaveAttribute("data-match", "meaning");
  await expect(hit).toContainText("By meaning");
  await expect(page.locator(".memory-item", { hasText: "Pasta night" })).toHaveCount(0);

  await page.getByLabel("Search memories").fill("dinner");
  await expect(page.locator(".memory-item").first()).toContainText("Pasta night");
  await expect(page.locator(".memory-item").first()).toHaveAttribute("data-match", "both");

  // The connector understands meaning on this machine too.
  const appKey = await connectApp(page, { name: "Claude Desktop", folders: ["Notes"] });
  const mcp = await connectMcp(appKey, baseURL!);
  const found = textOf(await mcp.callTool({ name: "search_memories", arguments: { query: "automobile" } }));
  expect(found).toContain("Brakes squeak");
  expect(found).toContain("matched by meaning");
  expect(found).not.toContain("Pasta night");
  await mcp.close();

  // Neither the query nor any vector went to the server.
  const wire = sent.join("\n");
  expect(wire).not.toContain("automobile");
  expect(wire).not.toContain("Brakes squeak");
});

test("the timeline lists memories by day and source, and duplicates are found and merged", async ({ page, context }) => {
  await installWallet(context);
  await createWithWallet(page);
  await writeMemory(page, { title: "Allergy", body: "I am allergic to penicillin and must avoid it." });
  await writeMemory(page, { title: "Allergy", body: "I am allergic to penicillin and must avoid it." });
  await writeMemory(page, { title: "Guitar", body: "Practice the new song." });

  await openTab(page, "Timeline");
  await expect(page.locator(".timeline-month")).toHaveCount(1);
  await expect(page.locator(".timeline-item")).toHaveCount(3);
  await expect(page.locator(".timeline-item").first()).toContainText("Written in Sigil");
  await page.locator(".timeline-item", { hasText: "Guitar" }).click();
  await expect(page.getByRole("tab", { name: "Memories" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Title")).toHaveValue("Guitar");

  await page.getByRole("button", { name: "Find duplicates" }).click();
  const pair = page.locator(".duplicate");
  await expect(pair).toHaveCount(1);
  await expect(pair).toContainText("The same text");
  await pair.getByRole("button", { name: "Delete the older" }).click();
  await expect(page.getByText("No duplicates found.")).toBeVisible();
  await expect(page.locator(".memory-item")).toHaveCount(2);
});
