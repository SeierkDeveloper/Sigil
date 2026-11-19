import type { BrowserContext, Page, Request } from "@playwright/test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "../..");

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
    env: { ...(process.env as Record<string, string>), SIGIL_APP_KEY: appKey, SIGIL_URL: baseUrl },
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
export async function createWithWallet(page: Page): Promise<string> {
  await page.goto("/vault");
  await page.getByRole("button", { name: "Create a vault" }).waitFor();
  await page.getByTestId("method-wallet").click();
  const phraseList = page.getByTestId("recovery-phrase");
  await phraseList.waitFor();
  const phrase = (await phraseList.locator("li").allInnerTexts()).map((w) => w.trim()).join(" ");
  await page.getByLabel("I have saved my recovery phrase somewhere safe.").check();
  await page.getByRole("button", { name: "Open my vault" }).click();
  await page.getByRole("heading", { name: "Your vault" }).waitFor();
  return phrase;
}
