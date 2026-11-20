// A sealed agreement across two browsers: Sam drafts and signs it, Robin reads
// it in their own vault and signs the same fingerprint, both see it signed, it
// is sealed in both logs, and a verifiable copy checks on the verify page in a
// third browser. The text never travels readable.

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createWithWallet, installWallet, recordBodies } from "./helpers";

const TEXT = "CANARY-terms Sam lends Robin the camera until 1 December. Robin returns it unharmed.";

test("an agreement is drafted in one vault, signed in another, sealed in both, and verified by anyone", async ({ browser, baseURL }) => {
  const samCtx = await browser.newContext({ acceptDownloads: true });
  const robinCtx = await browser.newContext();
  await installWallet(samCtx);
  await installWallet(robinCtx);
  const sam = await samCtx.newPage();
  const robin = await robinCtx.newPage();
  const wire = [...recordBodies(sam), ...recordBodies(robin)];

  await createWithWallet(robin);
  await robin.getByRole("tab", { name: "Folders" }).click();
  const robinCode = (await robin.getByTestId("vault-code").innerText()).trim();

  await createWithWallet(sam);
  await sam.getByRole("tab", { name: "Agreements" }).click();
  await sam.getByRole("button", { name: "Draft an agreement" }).click();
  const form = sam.getByRole("form", { name: "Draft an agreement" });
  await form.getByLabel("Their vault code").fill(robinCode);
  await form.getByLabel("Title").fill("The camera");
  await form.getByLabel("The agreement").fill(TEXT);
  await form.getByLabel("Your name, as you sign").fill("Sam");
  await form.getByLabel("Their name, as they sign").fill("Robin");
  await form.getByRole("button", { name: "Sign and send" }).click();
  const samCard = sam.getByTestId("agreement-card");
  await expect(samCard).toContainText("Waiting for a signature");

  await robin.getByRole("tab", { name: "Agreements" }).click();
  const robinCard = robin.getByTestId("agreement-card");
  await expect(robinCard).toContainText(TEXT, { timeout: 20_000 });
  await robinCard.getByRole("button", { name: "Sign it" }).click();
  await expect(robinCard).toContainText("Signed by both");
  await expect(samCard).toContainText("Signed by both", { timeout: 20_000 });

  // Once the hour (four seconds here) is sealed, Sam's copy carries its sealed entry.
  await sam.waitForTimeout(9_000);
  const download = sam.waitForEvent("download");
  await samCard.getByRole("button", { name: "Download a verifiable copy" }).click();
  const text = readFileSync((await (await download).path())!, "utf8");
  const copy = JSON.parse(text);
  expect(copy).toMatchObject({ format: "sigil-agreement", doc: { text: TEXT } });
  expect(copy.seal).not.toBeNull();

  const checker = await browser.newContext();
  const visitor = await checker.newPage();
  await visitor.goto("/verify#proof");
  await visitor.getByLabel("A signed file").setInputFiles({ name: "agreement.json", mimeType: "application/json", buffer: Buffer.from(text) });
  const result = visitor.getByTestId("document-result");
  await expect(result).toHaveAttribute("data-ok", "true");
  await expect(result.getByTestId("document-headline")).toHaveText("The camera");
  // One word changed after signing, and it no longer passes.
  copy.doc.text = copy.doc.text.replace("1 December", "1 January");
  await visitor.getByLabel("A signed file").setInputFiles({ name: "changed.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(copy)) });
  await expect(result).toHaveAttribute("data-ok", "false");

  // Both logs have it.
  await robin.getByRole("tab", { name: "Read log" }).click();
  await expect(robin.getByText("An agreement was signed by both: its fingerprint is sealed with this hour")).toBeVisible();

  const sent = wire.filter((b) => b.includes(baseURL!)).join("\n");
  expect(sent).not.toContain("CANARY-terms");
  await samCtx.close();
  await robinCtx.close();
  await checker.close();
});
