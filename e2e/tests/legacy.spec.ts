// Legacy in two real browsers: the owner names a trusted person by vault code
// and seals a plan, stays away for the whole period (a legacy day is 25 ms on
// the test server), and the trusted person asks for a release, combines the
// share in their browser, reads what was left to them and talks to the AI self
// in legacy mode. The owner comes back to a notice and a sealed log.

import { expect, test, type Page, type Route } from "@playwright/test";
import { createWithWallet, installWallet, recordBodies, writeMemory, openTab } from "./helpers";

const CANARY = "CANARY-legacy-e2e-81b2";
const MODEL_KEY = "sk-ant-e2e-CANARY-legacy-key";

async function unlock(page: Page) {
  await page.goto("/vault");
  await page.getByTestId("method-wallet").click();
  await expect(page.getByRole("heading", { name: "Your vault" })).toBeVisible();
}

async function mockModel(page: Page) {
  const systems: string[] = [];
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
  await page.route("https://api.anthropic.com/**", async (route: Route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = route.request().postDataJSON() as { system?: string };
    systems.push(body.system ?? "");
    return route.fulfill({
      status: 200,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({
        id: "msg_e2e",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "We kept bees at the summer house [1]." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
  });
  return systems;
}

test("a legacy plan is sealed, released after the owner is away, opened by the trusted person, and logged", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const anaCtx = await browser.newContext();
  await installWallet(ownerCtx);
  await installWallet(anaCtx);
  let owner = await ownerCtx.newPage();
  const ana = await anaCtx.newPage();
  const ownerWire = recordBodies(owner);
  const anaWire = recordBodies(ana);

  // Ana makes a vault and reads out her code.
  await createWithWallet(ana);
  await openTab(ana, "Folders");
  const code = (await ana.getByTestId("vault-code").innerText()).trim();

  // The owner writes a memory, sets up the AI self, and seals a plan that names Ana.
  await createWithWallet(owner);
  await writeMemory(owner, { title: "Summer house", body: `Bees every summer. ${CANARY}` });
  await openTab(owner, "AI self");
  const model = owner.getByRole("form", { name: "Model key" });
  await model.getByLabel("API key").fill(MODEL_KEY);
  await model.getByRole("button", { name: "Save key" }).click();
  const rules = owner.getByRole("form", { name: "Rules" });
  await rules.getByLabel("Name it uses").fill("Sam's AI self");
  await rules.getByLabel("Notes", { exact: true }).check();
  await rules.getByRole("button", { name: "Save rules" }).click();
  await expect(owner.getByText("Rules saved.")).toBeVisible();

  await openTab(owner, "Legacy");
  const form = owner.getByRole("form", { name: "Legacy plan" });
  await form.getByLabel("Your name, as they will see it").fill("Sam");
  await form.getByLabel("Release after this long without a sign of you").selectOption({ label: "3 months" });
  await form.locator(".legacy-add").getByLabel("What you call them").fill("Ana");
  await form.getByLabel("Their vault code").fill(code);
  await expect(form.locator(".legacy-add .fingerprint")).toBeVisible();
  await form.getByRole("button", { name: "Add Ana" }).click();
  const card = form.locator(".legacy-person-card");
  await expect(card.getByLabel("Notes", { exact: true })).toBeChecked();
  await card.getByLabel(/May talk to your AI self/).check();
  await form.getByLabel(/Leave my model key/).check();
  await form.getByRole("button", { name: "Seal the plan" }).click();
  await expect(owner.getByTestId("legacy-due")).toBeVisible();
  await expect(owner.locator(".legacy-person")).toContainText("Holds a share");

  // Ana sees she is named, and that nothing can be opened while Sam is active.
  await unlock(ana);
  await openTab(ana, "Legacy");
  await expect(ana.locator(".legacy-trusted-plan")).toContainText("Sam named you as Ana");

  // Sam goes away for the whole period.
  await owner.close();
  await ana.waitForTimeout(3500);

  await unlock(ana);
  await openTab(ana, "Legacy");
  const release = ana.getByTestId("legacy-release");
  await release.getByRole("button", { name: "Ask for a release" }).click();
  await expect(release).toContainText("1 of 1 in hand");
  await release.getByRole("button", { name: "Combine and open" }).click();
  const viewer = ana.getByTestId("legacy-viewer");
  await viewer.getByRole("button", { name: "Summer house" }).click();
  await expect(viewer).toContainText(`Bees every summer. ${CANARY}`);

  // The AI self in legacy mode, with the model key Sam left and the provider played by the test.
  const systems = await mockModel(ana);
  await expect(viewer.locator(".legacy-self .eyebrow")).toHaveText("Legacy mode");
  await viewer.getByLabel("Your question").fill("What did we do in summer?");
  await viewer.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(viewer.locator(".chat-turn").last()).toContainText("We kept bees at the summer house");
  expect(systems[0]).toContain("legacy mode");

  // Sam comes back: the plan closes, a notice says what happened, the log has every step.
  owner = await ownerCtx.newPage();
  const ownerWire2 = recordBodies(owner);
  await unlock(owner);
  await expect(owner.getByText(/While you were away your legacy plan reached the end of its period/)).toBeVisible();
  await openTab(owner, "Read log");
  await expect(owner.locator(".log-row", { hasText: "A trusted person asked for a release" })).toContainText("Ana");
  await expect(owner.locator(".log-row", { hasText: "A trusted person combined the shares and opened their bundle" })).toContainText("Ana");
  const asked = owner.locator(".log-row", { hasText: "Your AI self answered a question in legacy mode" });
  await asked.getByRole("button", { name: "Show the question and answer" }).click();
  await expect(asked.getByTestId("ask-note")).toContainText("What did we do in summer?");

  // Nothing readable reached Sigil: not the memory, not the model key.
  for (const wire of [ownerWire, anaWire, ownerWire2]) {
    const sigil = wire.filter((w) => !w.includes("api.anthropic.com")).join("\n");
    expect(sigil).not.toContain(CANARY);
    expect(sigil).not.toContain(MODEL_KEY);
  }
  await ownerCtx.close();
  await anaCtx.close();
});
