// The privacy score of an app, computed in the browser from the owner's own
// read log after a real connector read through MCP.

import { expect, test } from "@playwright/test";
import { connectApp, connectMcp, createWithWallet, installWallet, textOf, writeMemory } from "./helpers";

test("each app shows a privacy score made from its reads, with where every point went", async ({ page, context, baseURL }) => {
  await installWallet(context);
  await createWithWallet(page);
  await writeMemory(page, { title: "Trip plan", body: "Rome in May." });
  await writeMemory(page, { title: "Garden", body: "Plant tomatoes." });
  const appKey = await connectApp(page, { name: "Cursor", folders: ["Notes"] });

  await page.getByRole("tab", { name: "Apps" }).click();
  await expect(page.getByTestId("privacy-score")).toContainText("Privacy score 100");
  await expect(page.getByTestId("privacy-score")).toContainText("Not active");

  const client = await connectMcp(appKey, baseURL!);
  try {
    const found = textOf(await client.callTool({ name: "search_memories", arguments: { query: "trip" } }));
    const id = /id: ([A-Za-z0-9_-]+)/.exec(found)![1];
    expect(textOf(await client.callTool({ name: "read_memory", arguments: { id } }))).toContain("Rome in May.");
  } finally {
    await client.close();
  }

  await page.getByRole("tab", { name: "Memories" }).click();
  await page.getByRole("tab", { name: "Apps" }).click();
  const score = page.getByTestId("privacy-score");
  // One of two memories read in full (15), one folder (5), one active day (1): 79.
  await expect(score).toContainText("Privacy score 79");
  await expect(score).toContainText("Regular reader");
  await score.getByRole("button").click();
  await expect(score).toContainText("1 memory read in full, of 2 memories it may read.");
  await expect(score).toContainText("Folders read: Notes (1)");
  await expect(score.getByRole("link", { name: "How the score is made" })).toHaveAttribute("href", "/docs#privacy-score");
});
