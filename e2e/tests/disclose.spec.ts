// Proving a fact without showing it: one field of a memory and an age from a
// birth date, each signed by the vault and sealed with the hour (four seconds
// on the test server), shared by link or file and checked on the verify page
// in another browser, which sees only the claim. A changed file does not pass.

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createWithWallet, installWallet, recordBodies, writeMemory, openTab } from "./helpers";

const SECRET = "CANARY-passport-X1234567";

test("a proof of one field and of an age, verified in another browser, revealing nothing else", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ acceptDownloads: true });
  await installWallet(ctx);
  const page = await ctx.newPage();
  const wire = recordBodies(page);
  await createWithWallet(page);
  await writeMemory(page, { title: "Passport", body: `Born: 1990-04-02\nNationality: Example\nNumber: ${SECRET}` });

  await openTab(page, "Proof");
  const prove = page.locator("#prove");
  await prove.getByLabel("Memory").selectOption({ label: "Passport" });
  await prove.getByLabel("Field").selectOption({ label: "Nationality: Example" });
  await prove.getByRole("button", { name: "Make the proof" }).click();
  const row = page.getByTestId("proof-row").filter({ hasText: "Nationality: Example" });
  await expect(row).toContainText("Nationality: Example");
  // Complete once its hour is sealed.
  await expect(row).toHaveAttribute("data-sealed", "true", { timeout: 30_000 });
  await row.getByRole("button", { name: "Make a share link" }).click();
  const link = (await row.getByTestId("proof-link").innerText()).trim();
  expect(link).toMatch(/\/verify\?proof=[A-Za-z0-9_-]+$/);

  // An age: born before a day eighteen years ago, with the date kept back.
  await prove.getByRole("button", { name: "An age" }).click();
  await prove.getByLabel("Memory").selectOption({ label: "Passport" });
  await prove.getByLabel("At least this many years").fill("18");
  await prove.getByRole("button", { name: "Make the proof" }).click();
  const age = page.getByTestId("proof-row").filter({ hasText: "at least 18 years" });
  await expect(age).toHaveAttribute("data-sealed", "true", { timeout: 30_000 });
  const download = page.waitForEvent("download");
  await age.getByRole("button", { name: "Download" }).click();
  const text = readFileSync((await (await download).path())!, "utf8");
  expect(text).not.toContain("1990");
  expect(text).not.toContain(SECRET);

  // Someone with no vault opens the link.
  const visitorCtx = await browser.newContext();
  const visitor = await visitorCtx.newPage();
  await visitor.goto(link);
  const result = visitor.getByTestId("document-result");
  await expect(result).toHaveAttribute("data-ok", "true");
  await expect(result.getByTestId("document-headline")).toHaveText("Nationality: Example");
  await expect(visitor.locator("body")).not.toContainText(SECRET);

  // The age proof, from the file.
  await visitor.goto("/verify#proof");
  await visitor.getByLabel("A signed file").setInputFiles({ name: "age.json", mimeType: "application/json", buffer: Buffer.from(text) });
  await expect(result).toHaveAttribute("data-ok", "true");
  await expect(result).toContainText("at least 18 years");
  await expect(result).toContainText("owner's own statement");

  // Claiming a later day than was signed breaks it.
  const forged = JSON.parse(text);
  forged.statement.claim.date = "2020-01-01";
  await visitor.getByLabel("A signed file").setInputFiles({ name: "forged.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(forged)) });
  await expect(result).toHaveAttribute("data-ok", "false");

  // Taken down, the link opens nothing.
  await row.getByRole("button", { name: "Take down" }).click();
  await visitor.goto(link);
  await expect(visitor.getByTestId("document-result")).toContainText("no proof at this link");

  const sent = wire.filter((b) => b.includes(baseURL!)).join("\n");
  expect(sent).not.toContain(SECRET);
  expect(sent).not.toContain("1990-04-02");
  await ctx.close();
  await visitorCtx.close();
});
