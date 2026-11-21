import type { BrowserContext, Page, Request, Route } from "@playwright/test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "../..");

/** The tiny model in the repository, for the connector's search by meaning. Same as the server's in playwright.config.ts. */
export const MODEL_ENV = {
  SIGIL_EMBED_MODEL: "sigil/tiny-embedder",
  SIGIL_MODEL_DIR: path.join(ROOT, "packages/core/test/fixtures/tiny-model"),
  SIGIL_MODEL_FETCH: "off",
};

/** Installs a window.ethereum backed by a real key held in the test process. */
export async function installWallet(context: BrowserContext) {
  const account = privateKeyToAccount(generatePrivateKey());
  await context.exposeBinding("__sigilWalletSign", async (_src, hexMessage: string) => account.signMessage({ message: { raw: hexMessage as `0x${string}` } }));
  await context.addInitScript((address: string) => {
    const w = window as unknown as { ethereum: unknown; __sigilWalletSign(m: string): Promise<string> };
    w.ethereum = {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
        if (method === "eth_chainId") return "0x1";
        if (method === "personal_sign") return w.__sigilWalletSign((params as string[])[0]);
        throw Object.assign(new Error(`Unsupported ${method}`), { code: 4200 });
      },
    };
  }, account.address);
  return account;
}

/** Records every request body the page sends, to check that no plaintext leaves the browser. */
export function recordBodies(page: Page): string[] {
  const bodies: string[] = [];
  page.on("request", (r: Request) => {
    const body = r.postData();
    if (body) bodies.push(`${r.method()} ${r.url()}\n${body}`);
    bodies.push(r.url());
  });
  return bodies;
}

export async function connectMcp(appKey: string, baseUrl: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "connector/dist/index.js")],
    env: { ...(process.env as Record<string, string>), ...MODEL_ENV, SIGIL_APP_KEY: appKey, SIGIL_URL: baseUrl },
    stderr: "pipe",
  });
  const client = new Client({ name: "sigil-e2e", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

export function textOf(result: unknown): string {
  return ((result as { content?: { type: string; text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
}

/** Creates a vault with the injected wallet and lands on the dashboard. Returns the recovery phrase. */
export async function createWithWallet(page: Page, opts: { guide?: boolean } = {}): Promise<string> {
  await page.goto("/vault");
  await page.getByRole("button", { name: "Create a vault" }).waitFor();
  await page.getByTestId("method-wallet").click();
  const phraseList = page.getByTestId("recovery-phrase");
  await phraseList.waitFor();
  const phrase = (await phraseList.locator("li").allInnerTexts()).map((w) => w.trim()).join(" ");
  await confirmPhrase(page, phrase);
  await page.getByRole("button", { name: "Open my vault" }).click();
  await page.getByRole("heading", { name: "Your vault" }).waitFor();
  if (!opts.guide) await page.getByRole("button", { name: "Skip the guide" }).click();
  return phrase;
}

/** Ticks "saved" and types back the two words the phrase screen asks for. */
export async function confirmPhrase(page: Page, phrase: string) {
  await page.getByLabel("I have saved my recovery phrase somewhere safe.").check();
  const words = phrase.split(" ");
  const inputs = page.getByTestId("phrase-check").locator("input[data-word]");
  await inputs.first().waitFor();
  for (const input of await inputs.all()) {
    const n = Number(await input.getAttribute("data-word"));
    await input.fill(words[n - 1]);
  }
}

/**
 * Opens a section of the vault by its name: from the main row when it is
 * there, otherwise through More. Every deep link still works the same.
 */
export async function openTab(page: Page, name: string | RegExp) {
  // A tab's name may carry a count after it ("Inbox 1 waiting"); match the label at its start.
  const label = typeof name === "string" ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`) : name;
  const row = page.getByRole("tablist", { name: "Vault sections" });
  await row.waitFor();
  const tab = row.getByRole("tab", { name: label });
  if (await tab.count()) {
    await tab.first().click();
    return;
  }
  await page.getByTestId("tab-more").click();
  await page.getByRole("navigation", { name: "More sections" }).getByRole("button", { name: label }).first().click();
}

/** Connects an app from the Apps tab and returns its key. Folders by name; suggestions on or off. */
export async function connectApp(page: Page, opts: { name?: string; folders: string[]; suggest?: boolean; kind?: string }) {
  await openTab(page, "Apps");
  const first = page.getByRole("button", { name: "Connect your first app" });
  if (await first.isVisible()) await first.click();
  else await page.getByRole("button", { name: "Connect an app" }).click();
  const form = page.getByRole("form", { name: "Connect an app" });
  if (opts.kind) await form.getByLabel("App", { exact: true }).selectOption(opts.kind);
  if (opts.name) await form.getByLabel("Name in your vault").fill(opts.name);
  for (const f of opts.folders) await form.getByLabel(f, { exact: true }).check();
  if (opts.suggest) await form.getByLabel(/May suggest memories/).check();
  await form.getByRole("button", { name: "Create app key" }).click();
  const appKey = (await page.getByTestId("app-key").innerText()).trim();
  await page.getByLabel("I have copied the app key.").check();
  await page.getByRole("button", { name: "Done" }).click();
  return appKey;
}

export async function writeMemory(page: Page, m: { title: string; body: string; tags?: string; folder?: string }) {
  await openTab(page, "Memories");
  const empty = page.getByRole("button", { name: "Write a memory" });
  if (await empty.isVisible()) await empty.click();
  else await page.getByRole("button", { name: "New memory" }).click();
  const form = page.getByRole("form", { name: "New memory" });
  await form.getByLabel("Title").fill(m.title);
  await form.getByLabel("Memory", { exact: true }).fill(m.body);
  if (m.tags) await form.getByLabel("Tags").fill(m.tags);
  if (m.folder) await form.getByLabel("Folder").selectOption({ label: m.folder });
  await form.getByRole("button", { name: "Save memory" }).click();
  await page.locator(".memory-item-title", { hasText: m.title }).first().waitFor();
}

export async function addFolder(page: Page, name: string) {
  await openTab(page, "Folders");
  await page.getByLabel("New folder").fill(name);
  await page.getByRole("button", { name: "Add folder" }).click();
  await page.locator(".list-row-title", { hasText: name }).first().waitFor();
}

/** Plays the Anthropic API for one page or context: answers every call, and keeps what was asked. */
export async function mockModel(target: Page | BrowserContext, answer: (system: string, messages: { role: string; content: string }[]) => string) {
  const calls: { system: string; messages: { role: string; content: string }[] }[] = [];
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
  await target.route("https://api.anthropic.com/**", async (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = req.postDataJSON() as { system?: string; messages?: { role: string; content: string }[] };
    calls.push({ system: body.system ?? "", messages: body.messages ?? [] });
    return route.fulfill({
      status: 200,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({
        id: "msg_e2e",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: answer(body.system ?? "", body.messages ?? []) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
  });
  return calls;
}

/** Saves a model key and rules under AI self, so the vault's AI self can answer. */
export async function setUpModel(page: Page, opts: { key?: string; name?: string; folders?: string[] } = {}) {
  await openTab(page, "AI self");
  const model = page.getByRole("form", { name: "Model key" });
  await model.getByLabel("API key").fill(opts.key ?? "sk-ant-e2e-key-0001");
  await model.getByRole("button", { name: "Save key" }).click();
  await page.getByText("Anthropic, claude-opus-5-5, key").waitFor();
  const rules = page.getByRole("form", { name: "Rules" });
  await rules.getByLabel("Name it uses").fill(opts.name ?? "My AI self");
  for (const f of opts.folders ?? []) await rules.getByLabel(f, { exact: true }).check();
  await rules.getByRole("button", { name: "Save rules" }).click();
  await page.getByText("Rules saved.").waitFor();
}

/** The page as it is now, at 375 pixels wide: nothing past the right edge and no sideways scrolling. The window is set back afterwards. */
export async function fitsPhone(page: Page, where: string) {
  const before = page.viewportSize();
  await page.setViewportSize({ width: 375, height: 812 });
  const over = await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const wide = [...document.querySelectorAll<HTMLElement>("#main *")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        // Elements inside a horizontal scroller (the tab strip, code blocks, tables) may run wider.
        return r.width > 0 && r.right > window.innerWidth + 1 && !el.closest(".tabs, pre, .table-wrap, .code-block");
      })
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`);
    return { scroll: document.documentElement.scrollWidth, wide };
  });
  if (before) await page.setViewportSize(before);
  if (over.wide.length || over.scroll > 375) throw new Error(`${where} at 375 pixels: ${over.wide.length ? `past the right edge: ${over.wide.join(", ")}` : `the page is ${over.scroll} pixels wide`}`);
}
