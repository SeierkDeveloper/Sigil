// Shared memory across two browsers: the owner starts a family history, adds
// a story with a photo and a person, and names a friend's vault as heir. The
// owner's legacy plan releases while they are away; the heir becomes a member,
// accepts, and reads the timeline, then downloads it as a document.

import { expect, test } from "@playwright/test";
import { createWithWallet, fitsPhone, installWallet, recordBodies } from "./helpers";

const STORY = "CANARY-family-e2e-summerhouse";
// A one-pixel JPEG, for the photo of the story.
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

test("a family timeline outlives its owner: the heir becomes a member when the legacy plan releases", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const heirCtx = await browser.newContext();
  await installWallet(ownerCtx);
  await installWallet(heirCtx);
  const owner = await ownerCtx.newPage();
  const heir = await heirCtx.newPage();
  const wire = recordBodies(owner);

  await createWithWallet(heir);
  await heir.getByRole("tab", { name: "Folders" }).click();
  const code = (await heir.getByTestId("vault-code").innerText()).trim();

  await createWithWallet(owner);
  await owner.getByRole("tab", { name: "Shared memory" }).click();
  const start = owner.getByRole("form", { name: "New shared memory" });
  await start.getByLabel("Name", { exact: true }).fill("The Rivers family");
  await start.getByLabel("Your name in it").fill("Sam");
  await start.getByRole("button", { name: "Start it" }).click();

  const person = owner.getByRole("form", { name: "Add a person" });
  await person.getByLabel("Person's name").fill("Grandma Ines");
  await person.getByLabel("Relation").fill("grandmother");
  await person.getByRole("button", { name: "Add" }).click();
  const story = owner.getByRole("form", { name: "Add a story" });
  await story.getByLabel("Title").fill("The summer house");
  await story.getByLabel("When", { exact: true }).fill("1962-07");
  await story.getByLabel("What happened").fill(`We built it in one summer. ${STORY}`);
  await story.getByLabel("Grandma Ines").check();
  await story.locator('input[type="file"]').setInputFiles({ name: "house.jpg", mimeType: "image/jpeg", buffer: JPEG });
  await expect(story.locator(".memory-photo img")).toBeVisible();
  await story.getByRole("button", { name: "Add the story" }).click();
  const first = owner.getByTestId("story").first();
  await expect(first).toContainText("July 1962 · With Grandma Ines · Added by Sam");
  await expect(first.locator("img")).toBeVisible();

  const heirForm = owner.getByRole("form", { name: "Name an heir" });
  await heirForm.getByLabel("Heir's vault code").fill(code);
  await heirForm.getByLabel("Heir's name").fill("Ana");
  await heirForm.getByLabel("For", { exact: true }).selectOption({ label: "Sam" });
  await heirForm.getByRole("button", { name: "Name the heir" }).click();
  await expect(owner.getByTestId("heir")).toContainText("When Sam's legacy plan releases");
  await fitsPhone(owner, "Shared memory, a story and an heir");

  // Sam's legacy plan names Ana too, and Sam goes away for the whole period.
  await owner.getByRole("tab", { name: "Legacy" }).click();
  const plan = owner.getByRole("form", { name: "Legacy plan" });
  await plan.getByLabel("Your name, as they will see it").fill("Sam");
  await plan.getByLabel("Release after this long without a sign of you").selectOption({ label: "3 months" });
  await plan.locator(".legacy-add").getByLabel("What you call them").fill("Ana");
  await plan.getByLabel("Their vault code").fill(code);
  await plan.getByRole("button", { name: "Add Ana" }).click();
  await plan.getByRole("button", { name: "Seal the plan" }).click();
  await expect(owner.getByTestId("legacy-due")).toBeVisible();
  await owner.close();
  await heir.waitForTimeout(3500);

  // Ana asks for the release and opens her share: the heir becomes a member of the family history.
  await heir.goto("/vault");
  await heir.getByTestId("method-wallet").click();
  await heir.getByRole("tab", { name: "Legacy" }).click();
  const release = heir.getByTestId("legacy-release");
  await release.getByRole("button", { name: "Ask for a release" }).click();
  await release.getByRole("button", { name: "Combine and open" }).click();
  await expect(heir.getByTestId("legacy-viewer")).toBeVisible();
  await heir.reload();
  await heir.getByTestId("method-wallet").click();
  await heir.getByRole("tab", { name: "Shared memory" }).click();
  await heir.getByRole("button", { name: "Accept and open it" }).click();
  const hers = heir.getByTestId("story").first();
  await expect(hers).toContainText(`We built it in one summer. ${STORY}`);
  await expect(hers).toContainText("Added by Sam");
  await expect(heir.getByRole("form", { name: "Add a story" })).toHaveCount(0);
  const [download] = await Promise.all([heir.waitForEvent("download"), heir.getByTestId("history-download").click()]);
  expect(download.suggestedFilename()).toBe("the-rivers-family.html");
  await heir.getByRole("tab", { name: "Read log" }).click();
  await expect(heir.locator(".log-row", { hasText: "as an heir" })).toBeVisible();
  await fitsPhone(heir, "Shared memory, opened by the heir");

  // Nothing readable reached Sigil from the owner's browser.
  expect(wire.join("\n")).not.toContain(STORY);
  await ownerCtx.close();
  await heirCtx.close();
});
