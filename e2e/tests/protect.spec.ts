// A protected folder in a real browser and a real connector: the owner protects
// Health, an app asks through MCP and is held back, the owner says yes in the
// inbox, the same call then works once, and the read log marks it.

import { expect, test } from "@playwright/test";
import { addFolder, connectApp, connectMcp, createWithWallet, fitsPhone, installWallet, mockModel, setUpModel, textOf, writeMemory, openTab } from "./helpers";

const HEALTH = "CANARY-blood-e2e-55";

test("an app reads a protected folder only after the owner's yes, once, and the log says so", async ({ page, context, baseURL }) => {
  await installWallet(context);
  await createWithWallet(page);
  await addFolder(page, "Health");
  await writeMemory(page, { title: "Blood test", body: `${HEALTH} results are fine. Call 0701234567.`, folder: "Health" });

  // Protect it, and mask phone numbers.
  await openTab(page, "Folders");
  const row = page.locator(".list-row", { hasText: "Health" }).first();
  await row.getByRole("button", { name: "Protect" }).click();
  const form = page.getByRole("form", { name: "Protect Health" });
  await form.getByLabel("Protection").selectOption({ label: "Protected: Health" });
  await form.getByLabel("Phone numbers").check();
  await fitsPhone(page, "Folders, protecting one");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(row.getByTestId("folder-guard")).toContainText("Protected: Health");
  await fitsPhone(page, "Folders, one protected");

  const appKey = await connectApp(page, { name: "Claude", folders: ["Health"] });
  const client = await connectMcp(appKey, baseURL!);
  try {
    const folders = textOf(await client.callTool({ name: "list_folders", arguments: {} }));
    expect(folders).toContain("Health (1 memory, protected");

    // Looking through the folder asks the owner first.
    const held = textOf(await client.callTool({ name: "search_memories", arguments: { query: "blood", folder: "Health" } }));
    expect(held).toContain("asked in their Sigil inbox");
    expect(held).not.toContain(HEALTH);

    await openTab(page, "Inbox");
    const request = page.getByTestId("access-row").first();
    await expect(request).toContainText("Claude asks to read Health");
    await fitsPhone(page, "Inbox, a request to read a protected folder");
    await request.getByRole("button", { name: "Allow this read" }).click();
    await expect(page.getByTestId("access-requests")).toHaveCount(0);

    const found = textOf(await client.callTool({ name: "search_memories", arguments: { query: "blood", folder: "Health" } }));
    expect(found).toContain("Blood test");
    const id = /id: ([A-Za-z0-9_-]+)/.exec(found)![1];

    // Reading it is a read of its own: asked again, allowed again, then it comes, masked.
    expect(textOf(await client.callTool({ name: "read_memory", arguments: { id } }))).toContain("asked in their Sigil inbox");
    await openTab(page, "Memories");
    await openTab(page, "Inbox");
    await expect(page.getByTestId("access-row").first()).toContainText('To read "Blood test"');
    await page.getByTestId("access-row").first().getByRole("button", { name: "Allow this read" }).click();
    const full = textOf(await client.callTool({ name: "read_memory", arguments: { id } }));
    expect(full).toContain(HEALTH);
    expect(full).toContain("[phone number hidden]");
    expect(full).not.toContain("0701234567");

    // The yes covered that one read.
    expect(textOf(await client.callTool({ name: "read_memory", arguments: { id } }))).toContain("asked in their Sigil inbox");
  } finally {
    await client.close();
  }

  await openTab(page, "Read log");
  await expect(page.getByText('Read "Blood test" in a protected folder, after your yes')).toBeVisible();
  await expect(page.getByText("You allowed one read of a protected folder").first()).toBeVisible();
});

test("the test chat asks before it uses a protected folder, for that one answer", async ({ page, context }) => {
  await installWallet(context);
  const calls = await mockModel(page, (system) => (system.includes(HEALTH) ? "The results are fine [1]." : "I don't know that."));
  await createWithWallet(page);
  await addFolder(page, "Health");
  await writeMemory(page, { title: "Blood test", body: `${HEALTH} blood test results are fine.`, folder: "Health" });
  await openTab(page, "Folders");
  await page.locator(".list-row", { hasText: "Health" }).first().getByRole("button", { name: "Protect" }).click();
  const form = page.getByRole("form", { name: "Protect Health" });
  await form.getByLabel("Protection").selectOption({ label: "Protected: Health" });
  await form.getByRole("button", { name: "Save" }).click();
  await setUpModel(page, { name: "Sam's AI self", folders: ["Health"] });

  const chat = page.getByRole("form", { name: "Ask your AI self" });
  await chat.getByLabel("Question").fill("How was the blood test?");
  await chat.getByRole("button", { name: "Ask" }).click();
  const gate = page.getByTestId("protect-gate");
  await expect(gate).toContainText("1 memory from Health, a protected folder");
  expect(calls).toHaveLength(0);
  await fitsPhone(page, "Test chat, asking before a protected read");
  await gate.getByRole("button", { name: "Allow for this answer" }).click();
  await expect(page.getByTestId("chat-turn").first()).toContainText("The results are fine");
  expect(calls.at(-1)!.system).toContain(HEALTH);
});
