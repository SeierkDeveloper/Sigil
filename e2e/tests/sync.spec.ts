// Live sync in a real browser, with Google played by the test: the sign-in
// window, the token exchange with PKCE and the Gmail API are all answered here,
// so nothing reaches Google. The vault connects Gmail, the first pass writes
// encrypted memories, and Sigil's server never sees a token or a message.

import { expect, test, type BrowserContext, type Route } from "@playwright/test";
import { createWithWallet, fitsPhone, installWallet, recordBodies } from "./helpers";
import { gmailWorld, tokenServer } from "../../packages/core/test/fixtures/sync";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };

/** Plays Google: the consent page sends the window back with a code; the token endpoint and Gmail answer from the fixtures. */
async function playGoogle(context: BrowserContext, baseURL: string) {
  const mail = gmailWorld();
  const tokens = tokenServer();
  const consent: URL[] = [];
  await context.route("https://accounts.google.com/**", async (route: Route) => {
    const u = new URL(route.request().url());
    consent.push(u);
    return route.fulfill({ status: 302, headers: { location: `${baseURL}/vault/connect?code=good-code&state=${u.searchParams.get("state")}` } });
  });
  const relay = (fetcher: (i: string, init?: RequestInit) => Promise<Response>) => async (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const res = await fetcher(req.url(), { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined });
    return route.fulfill({ status: res.status, headers: { ...CORS, "content-type": res.headers.get("content-type") ?? "application/json" }, body: await res.text() });
  };
  await context.route("https://oauth2.googleapis.com/**", relay(tokens.fetch));
  await context.route("https://gmail.googleapis.com/**", relay(mail.fetch));
  return { consent, tokens, mail };
}

test("connects Gmail with PKCE from the browser and keeps it in sync, encrypted", async ({ page, context, baseURL }) => {
  await installWallet(context);
  const sent = recordBodies(page);
  const google = await playGoogle(context, baseURL!);
  await createWithWallet(page);

  await page.getByRole("tab", { name: "Sync" }).click();
  await expect(page.getByRole("heading", { name: "Live sync" })).toBeVisible();
  const form = page.getByRole("form", { name: "Connect a source" });
  await form.getByText("Gmail", { exact: true }).click();
  await form.getByRole("button", { name: "Connect Gmail" }).click();

  await expect(page.getByTestId("sync-row")).toContainText("Gmail");
  await expect(page.getByTestId("sync-row")).toContainText("me@example.org");
  await expect(page.getByText(/Gmail is connected: 2 memories so far/)).toBeVisible({ timeout: 30_000 });
  await fitsPhone(page, "Sync with one source");

  // The consent request asked for read-only mail, offline, with an S256 challenge and no secret.
  const asked = google.consent[0];
  expect(asked.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
  expect(asked.searchParams.get("code_challenge_method")).toBe("S256");
  expect(asked.toString()).not.toContain("secret");
  const exchange = new URLSearchParams(google.tokens.calls[0].body);
  expect(exchange.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(exchange.has("client_secret")).toBe(false);

  await page.getByRole("tab", { name: "Memories" }).click();
  await expect(page.locator(".memory-item-title", { hasText: "Launch plan" })).toBeVisible();
  await expect(page.locator(".memory-item-title", { hasText: "Your receipt" })).toBeVisible();

  // Pause, then disconnect: the sign-in is gone, the memories stay.
  await page.getByRole("tab", { name: "Sync" }).click();
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByTestId("sync-row")).toContainText("Paused");
  await fitsPhone(page, "Sync, paused");
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("button", { name: "Disconnect" }).last().click();
  await expect(page.getByTestId("sync-row")).toHaveCount(0);
  await page.getByRole("tab", { name: "Memories" }).click();
  await expect(page.locator(".memory-item-title", { hasText: "Launch plan" })).toBeVisible();

  // Sigil's server never got a token or a word of the mail.
  const wire = sent.filter((b) => b.includes(baseURL!)).join("\n");
  for (const secret of ["CANARY-access", "CANARY-refresh", "CANARY-mail-1", "Launch plan", "good-code"]) expect(wire, secret).not.toContain(secret);
});

test("a meeting transcript becomes a meeting memory, made in the browser", async ({ page, context }) => {
  await installWallet(context);
  await createWithWallet(page);
  await page.getByRole("tab", { name: "Import" }).click();
  await page.getByText("Meeting transcripts", { exact: true }).click();
  await fitsPhone(page, "Import, meeting transcripts chosen");
  await page.getByTestId("import-file").setInputFiles({
    name: "Launch sync.vtt",
    mimeType: "text/vtt",
    buffer: Buffer.from("WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\n<v Sam>We decided to launch on the 24th.</v>\n\n2\n00:00:05.000 --> 00:00:08.000\n<v Robin>I'll send the press note by Friday.</v>\n"),
  });
  await expect(page.getByTestId("import-preview")).toContainText("Meeting: Launch sync");
  await fitsPhone(page, "Import, a meeting transcript read");
  await page.getByRole("button", { name: "Import 1 memory" }).click();
  await expect(page.getByTestId("import-done")).toContainText("Imported 1 memory into Meetings");
  await page.getByRole("button", { name: "See memories" }).click();
  await page.locator(".memory-item-title", { hasText: "Meeting: Launch sync" }).click();
  await expect(page.getByLabel("Memory", { exact: true })).toHaveValue(/## Who was there\n- Sam\n- Robin/);
  await expect(page.getByLabel("Memory", { exact: true })).toHaveValue(/Robin: I'll send the press note by Friday\./);
});

test("a site without a client id says what to add, and the sign-in return window fits a phone", async ({ page, context }) => {
  await installWallet(context);
  await page.route("**/api/sync/config", (route) => route.fulfill({ json: { clients: { google: null, slack: null } } }));
  await createWithWallet(page);
  await page.getByRole("tab", { name: "Sync" }).click();
  const form = page.getByRole("form", { name: "Connect a source" });
  await expect(form).toContainText("This site has no Google sign-in set up yet");
  await expect(form).toContainText("SIGIL_GOOGLE_CLIENT_ID");
  await expect(form.getByRole("button", { name: "Connect Gmail" })).toBeDisabled();
  await fitsPhone(page, "Sync without a client id");

  // The window a service sends the owner back to. Opened on its own it has nothing to hand over, and stays.
  await page.goto("/vault/connect");
  await expect(page.getByRole("heading", { name: "Signing in" })).toBeVisible();
  await fitsPhone(page, "The sign-in return window");
});
