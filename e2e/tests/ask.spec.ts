// Ask your whole life, in a real browser: one question across every folder,
// first as the memories that answer best (no model key), then as a written
// answer from the owner's model, played by the test. Every sentence opens the
// memory it came from, and neither the question nor the answer reaches the server.

import { expect, test } from "@playwright/test";
import { addFolder, createWithWallet, installWallet, mockModel, openTab, recordBodies, setUpModel, writeMemory } from "./helpers";

const QUESTION = "What did I promise Ada?";

test("asks every folder at once, with and without a model, each sentence linked to its memory", async ({ page, context }) => {
  await installWallet(context);
  await createWithWallet(page);
  await addFolder(page, "People");
  await addFolder(page, "Kitchen");
  await writeMemory(page, { title: "Promise to Ada", body: "I promised Ada I would return her bridges book by the end of the month.", folder: "People" });
  await writeMemory(page, { title: "Lentil soup", body: "Red lentils, cumin and a lemon. Ada liked it with toasted bread.", folder: "Kitchen" });

  const bodies = recordBodies(page);
  await openTab(page, "Ask");
  await expect(page.getByRole("heading", { name: "Start with a question" })).toBeVisible();

  // No model key: the memories that answer best, grouped by folder.
  await page.getByLabel("Your question").fill(QUESTION);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const evidence = page.getByTestId("ask-evidence");
  await expect(evidence.getByRole("region", { name: "People" })).toContainText("Promise to Ada");
  await evidence.getByRole("button", { name: /Promise to Ada/ }).click();
  await expect(page.getByTestId("ask-reader")).toContainText("return her bridges book");

  // With a model key: a written answer, a sentence without a source left out.
  const calls = await mockModel(page, (system) => {
    const n = /<memory n="(\d+)" title="Promise to Ada"/.exec(system)?.[1];
    return `You promised Ada to return her bridges book by the end of the month [${n}]. She will be pleased.`;
  });
  await setUpModel(page, { folders: ["People"] });
  await openTab(page, "Ask");
  await page.getByLabel("Your question").fill(QUESTION);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const answer = page.getByTestId("ask-answer");
  await expect(page.getByTestId("ask-sentence")).toHaveCount(1);
  await expect(answer).toContainText("You promised Ada to return her bridges book by the end of the month.");
  await expect(answer).not.toContainText("She will be pleased");
  await expect(answer).toContainText("One sentence the model wrote could not be linked to a memory");
  await page.getByRole("button", { name: /^You promised Ada/ }).click();
  await expect(page.getByTestId("ask-reader")).toContainText("Promise to Ada");
  expect(calls[0].system).toContain("You are not the owner");

  // Saved as a memory in a folder the owner picks.
  await page.getByLabel("Keep this answer in").selectOption({ label: "People" });
  await page.getByRole("button", { name: "Save answer" }).click();
  await expect(page.getByText("Saved in People as a new memory")).toBeVisible();

  // The question and the answer never left the browser in readable form, except to the model provider.
  const toServer = bodies.filter((b) => !b.includes("api.anthropic.com"));
  expect(toServer.join("\n")).not.toContain("promise Ada");
  expect(toServer.join("\n")).not.toContain("bridges book");
});
