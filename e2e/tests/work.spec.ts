// The AI self at work: a reply drafted into the approval queue, changed by the
// owner and approved; the change becomes a note under How I write, and the
// next draft follows it. Nothing is sent anywhere, and the server reads none of it.

import { expect, test } from "@playwright/test";
import { createWithWallet, installWallet, recordBodies } from "./helpers";

test("a draft is approved with an edit, the self learns from it, and the next draft uses it", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext();
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  await installWallet(ctx);
  const page = await ctx.newPage();
  const wire = recordBodies(page);
  await createWithWallet(page);

  await page.getByRole("tab", { name: "Work" }).click();
  const ask = page.getByRole("form", { name: "Ask for a draft" });
  await ask.getByLabel("The message").fill("Subject: The invoice\n\nCANARY-message Could you confirm when the invoice will be paid?");
  await ask.getByLabel("From").fill("Alex Example");
  await ask.getByRole("button", { name: "Draft a reply" }).click();

  const card = page.getByTestId("draft-card");
  await expect(card).toHaveCount(1);
  const draft = card.getByLabel("Draft");
  await expect(draft).toHaveValue(/^Hi Alex,/);
  await expect(page.getByRole("tab", { name: /Work/ }).locator(".tab-count")).toHaveText("1");

  // The owner rewrites it in their own way and approves.
  await draft.fill("Hey Alex,\n\nCANARY-edit It goes out on Friday.\n\nCheers,\nSam");
  await expect(card).toContainText("Your change will be noted under How I write.");
  await card.getByRole("button", { name: "Approve and copy" }).click();
  await expect(page.getByTestId("draft-card")).toHaveCount(0);
  await expect(page.getByTestId("draft-done")).toContainText("Approved");

  // What it learned is shown, and can be changed or deleted.
  const lesson = page.getByTestId("lesson");
  await expect(lesson).toHaveCount(1);
  await expect(lesson).toContainText("Greeting: Hey {name},");
  await expect(lesson).toContainText("Sign-off: Cheers,\\nSam");

  // The next draft opens and closes the way the owner does.
  await ask.getByLabel("The message").fill("Lunch on Friday?");
  await ask.getByLabel("From").fill("Robin");
  await ask.getByRole("button", { name: "Draft a reply" }).click();
  const next = page.getByTestId("draft-card").getByLabel("Draft");
  await expect(next).toHaveValue(/^Hey Robin,/);
  await expect(next).toHaveValue(/Cheers,\nSam$/);

  // The owner removes the note: the draft after that is back to plain.
  await lesson.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("lesson")).toHaveCount(0);

  // All of it is in the read log.
  await page.getByRole("tab", { name: "Read log" }).click();
  await expect(page.getByText("Your edit became a note under How I write")).toBeVisible();
  await expect(page.getByText("You approved a reply")).toBeVisible();

  const sent = wire.filter((b) => b.includes(baseURL!)).join("\n");
  for (const plain of ["CANARY-message", "CANARY-edit", "Hey Alex", "Cheers"]) expect(sent, plain).not.toContain(plain);
  await ctx.close();
});
