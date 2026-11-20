// Moving a vault between two nodes running on this machine: the owner signs
// the move on the first node, carries the code to the second, signs in there
// with the same wallet, and the vault arrives with its memories and its ask
// link. The first node then sends the link on and turns sign-ins away.

import { expect, test } from "@playwright/test";
import { createWithWallet, fitsPhone, installWallet, recordBodies, setUpModel, writeMemory } from "./helpers";
import { BASE_URL, SECOND_URL } from "../playwright.config";

const CANARY = "CANARY-move-e2e-38c";

test("a vault moves to another node, and the old node sends its links on", async ({ page, context }) => {
  await installWallet(context);
  const sent = recordBodies(page);
  await createWithWallet(page);
  await writeMemory(page, { title: "The move", body: `Packed on Sunday. ${CANARY}` });
  await setUpModel(page, { name: "Sam's AI self", folders: ["Notes"] });

  // An ask link, so there is an address to send on.
  await page.getByRole("button", { name: "New link" }).click();
  const linkForm = page.getByRole("form", { name: "New link" });
  await linkForm.getByLabel("Label").fill("Friends");
  await linkForm.getByRole("button", { name: "Make link" }).click();
  const askUrl = (await page.getByTestId("ask-url").innerText()).trim();
  expect(askUrl.startsWith(`${BASE_URL}/ask/`)).toBe(true);

  await page.getByRole("tab", { name: "Storage" }).click();
  const move = page.getByRole("form", { name: "Move to another node" });
  await move.getByLabel("Its address").fill(SECOND_URL);
  await move.getByLabel("Send links on for").selectOption({ label: "7 days" });
  await move.getByRole("button", { name: "Sign the move" }).click();
  await expect(page.getByTestId("move-url")).toContainText(`${SECOND_URL}/vault/restore#move=sigil_move.`);
  await fitsPhone(page, "Storage, a move signed");

  // On the new node, in the same browser: the code fetches the vault from the old node; the wallet opens it here.
  await page.getByTestId("move-open").click();
  await expect(page.getByRole("heading", { name: "Move your vault here" })).toBeVisible();
  await expect(page.getByTestId("restore-facts")).toContainText("Memories");
  await page.getByTestId("restore-wallet").click();
  await expect(page.getByTestId("restore-done")).toContainText("The old node confirmed the move");
  await page.getByRole("button", { name: "Open your vault" }).click();
  await expect(page.getByRole("heading", { name: "Your vault", exact: true })).toBeVisible();
  expect(page.url().startsWith(SECOND_URL)).toBe(true);
  await expect(page.getByTestId("node-list")).toContainText(BASE_URL);
  await expect(page.getByTestId("node-list")).toContainText("Came from");
  await page.getByRole("tab", { name: "Memories" }).click();
  await expect(page.locator(".memory-item-title", { hasText: "The move" })).toBeVisible();
  await page.getByRole("tab", { name: "Read log" }).click();
  await expect(page.locator(".log-row", { hasText: "The vault arrived here from another node" })).toBeVisible();
  await expect(page.locator(".log-row", { hasText: "The old node confirmed the move" })).toBeVisible();

  // The old address of the ask link now opens on the new node, with the key in its fragment.
  const asker = await context.newPage();
  await asker.goto(askUrl);
  await expect(asker).toHaveURL(new RegExp(`^${SECOND_URL}/ask/`));
  expect(new URL(asker.url()).hash).toBe(new URL(askUrl).hash);
  await expect(asker.getByRole("heading", { name: "Sam's AI self" })).toBeVisible();

  // The old node sends sign-ins on too.
  const back = await context.newPage();
  await back.goto(`${BASE_URL}/vault`);
  await back.getByRole("button", { name: "Sign in", exact: true }).click();
  await back.getByTestId("method-wallet").click();
  await expect(back.locator(".notice-error")).toContainText(`moved to another node: ${SECOND_URL}`);
  expect(sent.join("\n")).not.toContain(CANARY);
});
