// Selves meet selves in two real browsers: Sam invites Robin's AI self by
// vault code to find a time, Robin says yes, both vaults stay open and their
// selves take turns with each owner's own model (played by the test), and
// both owners read the same transcript. The server relays only boxes.

import { expect, test } from "@playwright/test";
import { addFolder, createWithWallet, fitsPhone, installWallet, mockModel, recordBodies, setUpModel, writeMemory, openTab } from "./helpers";

test("two AI selves talk after both said yes, end to end encrypted, and both owners get the transcript", async ({ browser, baseURL }) => {
  const samCtx = await browser.newContext();
  const robinCtx = await browser.newContext();
  await installWallet(samCtx);
  await installWallet(robinCtx);
  const sam = await samCtx.newPage();
  const robin = await robinCtx.newPage();
  const samModel = await mockModel(sam, (system) => (system.includes("CANARY-dentist") ? "I can do Tuesday at 14:00. Does that suit you?" : "I have nothing to offer."));
  const robinModel = await mockModel(robin, () => "Tuesday at 14:00 works for Robin. [done]");
  const sent = [...recordBodies(sam), ...recordBodies(robin)];

  await createWithWallet(robin);
  await openTab(robin, "Folders");
  const robinCode = (await robin.getByTestId("vault-code").innerText()).trim();
  await setUpModel(robin, { name: "Robin's AI self" });

  await createWithWallet(sam);
  await addFolder(sam, "Calendar");
  await writeMemory(sam, { title: "Dentist", body: "CANARY-dentist When: 2026-11-24 10:00 to 11:00", folder: "Calendar" });
  await setUpModel(sam, { name: "Sam's AI self" });

  await openTab(sam, "Meet");
  await sam.getByRole("button", { name: "Invite another self" }).click();
  const form = sam.getByRole("form", { name: "Invite another self" });
  await form.getByLabel("Their vault code").fill(robinCode);
  await form.getByLabel("A line for both selves").fill("30 minutes next week");
  await form.getByLabel("What you call them").fill("Robin");
  await form.getByLabel("Your name, as they see it").fill("Sam");
  await form.getByLabel("Calendar", { exact: true }).check();
  await fitsPhone(sam, "Meet, the invite form");
  await form.getByRole("button", { name: "Send invite" }).click();
  await expect(sam.getByTestId("meet-card")).toContainText("Waiting for a yes");

  await openTab(robin, "Meet");
  const invite = robin.getByTestId("meet-invite");
  await expect(invite).toContainText("Sam invites your AI self", { timeout: 20_000 });
  await expect(invite).toContainText("30 minutes next week");
  await invite.getByLabel("Your name, as they see it").fill("Robin");
  await fitsPhone(robin, "Meet, an invite waiting");
  await invite.getByRole("button", { name: "Say yes" }).click();

  // Both vaults are open: Sam's self writes turn 1, Robin's turn 2 and ends it.
  for (const p of [sam, robin]) {
    const lines = p.getByTestId("meet-line");
    await expect(lines).toHaveCount(2, { timeout: 45_000 });
    await expect(lines.nth(0)).toContainText("I can do Tuesday at 14:00.");
    await expect(lines.nth(1)).toContainText("Tuesday at 14:00 works for Robin.");
    await expect(p.getByTestId("meet-card")).toContainText("Done");
  }
  await fitsPhone(sam, "Meet, the transcript");
  expect(samModel[0].system).toContain("CANARY-dentist");
  expect(robinModel[0].system).not.toContain("CANARY-dentist");

  // Nothing readable went through Sigil.
  const wire = sent.filter((b) => b.includes(baseURL!)).join("\n");
  for (const plain of ["Tuesday at 14:00", "CANARY-dentist", "30 minutes next week"]) expect(wire, plain).not.toContain(plain);

  // Both logs have it.
  await openTab(robin, "Read log");
  await expect(robin.getByText("The conversation ended after 2 turns")).toBeVisible();
  await samCtx.close();
  await robinCtx.close();
});
