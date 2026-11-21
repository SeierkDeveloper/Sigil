// The public AI self in real browsers: the owner publishes one folder, a
// visitor opens /@handle and asks, the owner's open vault answers with the
// owner's model (played by the test) from the public copy only, the answer is
// marked as AI with its source, and the owner's log has the question.

import { expect, test } from "@playwright/test";
import { addFolder, createWithWallet, fitsPhone, installWallet, mockModel, recordBodies, setUpModel, writeMemory, openTab } from "./helpers";

const TALK = "CANARY-talks-e2e I speak about memory and privacy.";
const PRIVATE = "CANARY-private-e2e";

test("anyone can ask the public AI self, answered only from what was made public", async ({ page, context, browser, baseURL }) => {
  await installWallet(context);
  const calls = await mockModel(page, (system) => (system.includes("CANARY-talks-e2e") ? "I talk about memory and privacy [1]." : "I don't know that."));
  const ownerSent = recordBodies(page);
  await createWithWallet(page);
  await writeMemory(page, { title: "Diary", body: PRIVATE });
  await addFolder(page, "Public work");
  await writeMemory(page, { title: "Talks", body: TALK, folder: "Public work" });
  await setUpModel(page, { name: "Sam's AI self", folders: ["Notes"] });

  const form = page.getByRole("form", { name: "Public AI self" });
  await form.getByLabel("Handle").fill("sam-e2e");
  await form.getByLabel("Name it uses").fill("Sam's AI self");
  await form.getByLabel("Greeting").fill("Ask me about my talks.");
  await form.getByLabel("Public work").check();
  await form.getByLabel("Show answered questions on the page").check();
  await fitsPhone(page, "AI self, the public AI self form");
  await form.getByRole("button", { name: "Save and publish" }).click();
  await expect(page.getByTestId("public-url")).toHaveText(`${baseURL}/@sam-e2e`);

  const guest = await browser.newContext();
  const visitor = await guest.newPage();
  const visitorSent = recordBodies(visitor);
  await visitor.goto("/@sam-e2e");
  await expect(visitor.getByRole("heading", { name: "Sam's AI self" })).toBeVisible();
  await expect(visitor.getByTestId("public-status")).toContainText("Online", { timeout: 20_000 });
  await visitor.getByLabel("Your question").fill("What do you talk about?");
  await visitor.getByRole("button", { name: "Ask" }).click();
  const turn = visitor.getByTestId("public-turn").first();
  await expect(turn).toContainText("I talk about memory and privacy.", { timeout: 30_000 });
  await expect(turn.locator(".chat-by-kind")).toHaveText("AI");
  await turn.getByRole("button", { name: "Talks" }).click();
  await expect(visitor.getByTestId("public-source")).toContainText("CANARY-talks-e2e");
  await fitsPhone(visitor, "The public page, an answer with its source open");

  // The owner's model saw the public copy and nothing private; the server relayed only boxes.
  expect(calls.at(-1)!.system).toContain("CANARY-talks-e2e");
  expect(calls.at(-1)!.system).not.toContain(PRIVATE);
  // The visitor's question went to Sigil sealed; it is shown on the page only because the owner chose to show answers.
  const wire = visitorSent.filter((b) => b.includes(baseURL!)).join("\n");
  expect(wire).not.toContain("What do you talk about?");
  expect(ownerSent.join("\n")).not.toContain(PRIVATE);

  // The owner sees it in the log, and can hide it from the page.
  await openTab(page, "Read log");
  await page.getByRole("button", { name: "Refresh" }).click();
  const entry = page.locator(".log-row", { hasText: "Your public AI self answered a visitor" }).first();
  await entry.getByRole("button", { name: "Show the question and answer" }).click();
  await expect(entry.getByTestId("ask-note")).toContainText("What do you talk about?");
  await openTab(page, "AI self");
  const wall = page.getByTestId("wall-row").first();
  await expect(wall).toContainText("What do you talk about?", { timeout: 20_000 });
  await wall.getByRole("button", { name: "Hide" }).click();
  await expect(wall).toContainText("Hidden");
  await expect(page.getByTestId("public-self").locator(".public-facts")).toContainText("Answered1");
  await fitsPhone(page, "AI self, the public AI self set up");

  // The vault closes: the page says plainly that it is offline.
  await page.close();
  await visitor.reload();
  await expect(visitor.getByTestId("public-status")).toContainText("Offline right now", { timeout: 20_000 });
  await expect(visitor.getByRole("button", { name: "Ask" })).toBeDisabled();
  await fitsPhone(visitor, "The public page, offline");
  await visitor.goto("/@nobody-here");
  await expect(visitor.getByRole("heading", { name: "No public AI self here" })).toBeVisible();
  await fitsPhone(visitor, "The public page, no such handle");
  await guest.close();
});
