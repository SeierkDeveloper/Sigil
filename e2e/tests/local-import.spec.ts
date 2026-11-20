// Local imports in a real browser: a Google Takeout zip and an Obsidian folder,
// read and encrypted in the page, with a preview, a folder choice and dedupe
// against what the vault already holds.

import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { obsidianFiles, takeoutZip } from "../../packages/core/test/fixtures/local";
import { createWithWallet, installWallet, recordBodies } from "./helpers";

const CANARY = "CANARY-local-import-e2e";

test("imports mail and calendar from Takeout, and an Obsidian folder, encrypted, without doubles", async ({ page, context, baseURL }) => {
  const dir = mkdtempSync(path.join(tmpdir(), "sigil-local-import-"));
  const zip = path.join(dir, "takeout.zip");
  writeFileSync(zip, takeoutZip(CANARY));
  const vaultDir = path.join(dir, "My vault");
  for (const f of obsidianFiles(CANARY)) {
    mkdirSync(path.dirname(path.join(vaultDir, f.path)), { recursive: true });
    writeFileSync(path.join(vaultDir, f.path), f.bytes);
  }

  await installWallet(context);
  const sent = recordBodies(page);
  await createWithWallet(page);
  await page.getByRole("tab", { name: "Import" }).click();

  // Google Takeout.
  await page.getByText("Gmail and Google Calendar", { exact: true }).click();
  await page.getByTestId("import-file").setInputFiles(zip);
  const preview = page.getByTestId("import-preview");
  await expect(preview).toContainText("Gmail and Google Calendar: 4 items found");
  await expect(preview).toContainText("4 new memories to import.");
  await expect(preview).toContainText("Trip to the coast");
  await expect(preview.getByLabel("Save into")).toHaveValue("__new__");
  await preview.getByRole("button", { name: "Import 4 memories" }).click();
  await expect(page.getByTestId("import-done")).toContainText("Imported 4 memories into Google.");

  // The same zip again adds nothing.
  await page.getByRole("button", { name: "Import something else" }).click();
  await page.getByText("Gmail and Google Calendar", { exact: true }).click();
  await page.getByTestId("import-file").setInputFiles(zip);
  await expect(preview).toContainText("Everything in this file is already in your vault.");
  await expect(preview).toContainText("4 items already in your vault will be skipped.");
  await preview.getByRole("button", { name: "Choose something else" }).click();

  // An Obsidian folder, picked as a folder.
  await page.getByText("Obsidian", { exact: true }).click();
  await page.getByTestId("import-folder").setInputFiles(vaultDir);
  await expect(preview).toContainText("Obsidian: 2 items found");
  await preview.getByRole("button", { name: "Import 2 memories" }).click();
  await expect(page.getByTestId("import-done")).toContainText("Imported 2 memories into Obsidian.");
  await expect(page.getByTestId("import-done")).toContainText("--watch");

  await page.getByRole("button", { name: "See memories" }).click();
  await page.locator(".memory-item-title", { hasText: "2026-03-01" }).click();
  await expect(page.locator(".editor-meta")).toContainText("Imported from Obsidian");
  await page.getByLabel("Search memories").fill("dentist");
  await expect(page.locator(".memory-item").first()).toContainText("Dentist");

  const wire = sent.filter((b) => b.includes(baseURL!)).join("\n");
  for (const secret of [CANARY, "Trip to the coast", "Dentist", "south wall"]) expect(wire, secret).not.toContain(secret);
});
