// Your AI self in a real browser, with the model provider played by the test:
// requests to the provider are answered here, so nothing reaches a real model
// or the network. The test chat, and an "Ask my AI self" link answered by the
// owner's open vault while another browser asks, end to end encrypted.

import { expect, test, type Page, type Route } from "@playwright/test";
import { addFolder, createWithWallet, installWallet, recordBodies, writeMemory, openTab } from "./helpers";

const MODEL_KEY = "sk-ant-e2e-CANARY-key-5d1f";
const FOOD = "CANARY-risotto-e2e";
const HEALTH = "CANARY-health-e2e";
const QUESTION = "What food do you love most?";

/** Plays the model provider for one page: answers every call, and keeps what was asked. */
async function mockModel(page: Page, answer: (system: string) => string) {
  const calls: { headers: Record<string, string>; body: { system?: string; messages?: { content: string }[] } }[] = [];
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
  await page.route("https://api.anthropic.com/**", async (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = req.postDataJSON() as { system?: string; messages?: { content: string }[] };
    calls.push({ headers: req.headers(), body });
    return route.fulfill({
      status: 200,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({
        id: "msg_e2e",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: answer(body.system ?? "") }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
  });
  return calls;
}

async function setUpSelf(page: Page) {
  await createWithWallet(page);
  await writeMemory(page, { title: "Favourite food", body: `My favourite food is ${FOOD}.` });
  await addFolder(page, "Health");
  await writeMemory(page, { title: "Blood test", body: `${HEALTH} food diary.`, folder: "Health" });

  await openTab(page, "AI self");
  const model = page.getByRole("form", { name: "Model key" });
  await expect(model.getByLabel("Model")).toHaveValue("claude-opus-5-5");
  await model.getByLabel("API key").fill(MODEL_KEY);
  await model.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText("Anthropic, claude-opus-5-5, key")).toBeVisible();

  const rules = page.getByRole("form", { name: "Rules" });
  await rules.getByLabel("Name it uses").fill("Sam's AI self");
  await rules.getByLabel("Notes", { exact: true }).check();
  await rules.getByLabel("Topics it never talks about").fill("salary");
  await rules.getByRole("button", { name: "Save rules" }).click();
  await expect(page.getByText("Rules saved.")).toBeVisible();
}

const sigilOnly = (bodies: string[], origin: string) => bodies.filter((b) => b.includes(origin)).join("\n");

test("the test chat answers as the owner from the allowed folders, with the memories it used", async ({ page, context, baseURL }) => {
  await installWallet(context);
  const sent = recordBodies(page);
  const calls = await mockModel(page, (system) => (system.includes(FOOD) ? `My favourite is ${FOOD} [1].` : "I don't know that."));
  await setUpSelf(page);

  const chat = page.getByRole("form", { name: "Ask your AI self" });
  await chat.getByLabel("Question").fill(QUESTION);
  await chat.getByRole("button", { name: "Ask" }).click();
  const turn = page.getByTestId("chat-turn").first();
  await expect(turn).toContainText(`My favourite is ${FOOD} [1].`);
  await expect(turn.getByRole("button", { name: "Favourite food" })).toBeVisible();

  // The browser called the provider itself, with the owner's key and only the allowed folder.
  expect(calls).toHaveLength(1);
  expect(`${calls[0].headers["x-api-key"] ?? ""} ${calls[0].headers.authorization ?? ""}`).toContain(MODEL_KEY);
  expect(calls[0].body.system).toContain(FOOD);
  expect(calls[0].body.system).not.toContain(HEALTH);

  // A denied topic is refused without asking the model.
  await chat.getByLabel("Question").fill("What is your salary?");
  await chat.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByTestId("chat-turn").nth(1)).toContainText("a topic it never talks about");
  expect(calls).toHaveLength(1);

  // The citation opens the memory.
  await turn.getByRole("button", { name: "Favourite food" }).click();
  await expect(page.getByLabel("Title")).toHaveValue("Favourite food");

  // Sigil's server never got the key, the rules or the memory in readable form.
  const wire = sigilOnly(sent, baseURL!);
  for (const secret of [MODEL_KEY, FOOD, "Sam's AI self", "salary"]) expect(wire, secret).not.toContain(secret);
});

test("an ask link: another browser asks, the open vault answers, and the owner's log has it", async ({ page, context, browser, baseURL }) => {
  await installWallet(context);
  const ownerSent = recordBodies(page);
  const calls = await mockModel(page, (system) => (system.includes(FOOD) ? `I love ${FOOD} [1].` : "I don't know that."));
  await setUpSelf(page);

  await page.getByRole("button", { name: "New link" }).click();
  const form = page.getByRole("form", { name: "New link" });
  await form.getByLabel("Label").fill("Book club");
  await form.getByLabel("Greeting").fill("Ask me about food.");
  await form.getByRole("button", { name: "Make link" }).click();
  const url = (await page.getByTestId("ask-url").innerText()).trim();
  expect(url.startsWith(`${baseURL}/ask/`)).toBe(true);
  expect(url).toContain("#");
  await expect(page.getByTestId("link-row")).toContainText("Book club");
  await expect(page.locator(".self-status")).toHaveAttribute("data-state", "serving");

  // Someone else opens the link in their own browser.
  const guest = await browser.newContext();
  const ask = await guest.newPage();
  const guestSent = recordBodies(ask);
  await ask.goto(url);
  await expect(ask.getByRole("heading", { name: "Sam's AI self" })).toBeVisible();
  await expect(ask.getByText("Ask me about food.")).toBeVisible();
  await expect(ask.getByTestId("ask-status")).toHaveAttribute("data-online", "true", { timeout: 20_000 });

  await ask.getByLabel("Your question").fill(QUESTION);
  await ask.getByRole("button", { name: "Ask" }).click();
  const answer = ask.getByTestId("ask-turn").first();
  await expect(answer).toHaveAttribute("data-status", "answered", { timeout: 30_000 });
  // The guest sees the answer without the numbers that point into the vault.
  await expect(answer).toContainText(`I love ${FOOD}.`);
  await expect(answer).not.toContainText("[1]");
  expect(calls.at(-1)?.body.messages?.at(-1)?.content).toBe(QUESTION);
  expect(calls.at(-1)?.body.system).not.toContain(HEALTH);

  // The question and answer travelled sealed: neither browser sent them to Sigil in readable form.
  const guestWire = guestSent.join("\n");
  expect(guestWire).not.toContain(QUESTION);
  expect(guestWire).not.toContain(url.split("#")[1]);
  const ownerWire = sigilOnly(ownerSent, baseURL!);
  for (const secret of [QUESTION, FOOD, MODEL_KEY, "Book club", "Ask me about food"]) expect(ownerWire, secret).not.toContain(secret);

  // The owner's read log holds the question and answer, opened with the vault's key.
  await openTab(page, "Read log");
  const row = page.locator(".log-row[data-kind='ask']").first();
  await expect(row).toContainText("Your AI self answered a question, from 1 memory");
  await expect(row).toContainText('Ask link "Book club"');
  await row.getByRole("button", { name: "Show the question and answer" }).click();
  await expect(row.getByTestId("ask-note")).toContainText(QUESTION);
  await expect(row.getByTestId("ask-note")).toContainText(`I love ${FOOD}.`);

  // Locked, the vault stops answering and the link says so honestly.
  await page.getByRole("button", { name: "Lock vault" }).click();
  await ask.reload();
  await expect(ask.getByTestId("ask-status")).toHaveAttribute("data-online", "false", { timeout: 20_000 });
  await expect(ask.getByTestId("ask-status")).toContainText("Offline right now");
  await expect(ask.getByRole("button", { name: "Ask" })).toBeDisabled();

  // A link with its key cut off, or a wrong key, sends nothing.
  await ask.goto(url.split("#")[0]);
  await expect(ask.getByRole("heading", { name: "This link cannot be used" })).toBeVisible();
  await guest.close();
});

test("turning a link off stops it at once", async ({ page, context, browser }) => {
  await installWallet(context);
  await mockModel(page, () => "Hello.");
  await setUpSelf(page);
  await page.getByRole("button", { name: "New link" }).click();
  await page.getByRole("form", { name: "New link" }).getByRole("button", { name: "Make link" }).click();
  const url = (await page.getByTestId("ask-url").innerText()).trim();
  await page.getByRole("button", { name: "Done" }).click();
  const row = page.getByTestId("link-row");
  await row.getByRole("button", { name: "Turn off" }).click();
  await row.getByRole("button", { name: "Turn off now" }).click();
  await expect(row).toContainText("Turned off");
  const guest = await browser.newContext();
  const ask = await guest.newPage();
  await ask.goto(url);
  await expect(ask.getByTestId("ask-status")).toContainText("The owner turned this link off.");
  await expect(ask.getByLabel("Your question")).toHaveCount(0);
  await guest.close();
});
