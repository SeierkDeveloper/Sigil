// A self that acts in the owner's own Gmail, in a real browser, with Google
// played by the test: the owner lets the self act in a connected Gmail
// account, Google is asked once more for sending, and the next pass replies on
// its own to a listed sender and keeps a step from anyone else waiting in Work.
// The owner says yes with their own text and it is sent from the browser.
// Sigil's server never sees a token, a message or a reply.

import { expect, test, type BrowserContext, type Route } from "@playwright/test";
import { createWithWallet, fitsPhone, installWallet, openTab, recordBodies } from "./helpers";
import { fake, gmailMessage, json } from "../../packages/core/test/fixtures/sync";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PATCH, OPTIONS" };
const READ = "https://www.googleapis.com/auth/gmail.readonly";
const SEND = "https://www.googleapis.com/auth/gmail.send";

async function playGoogle(context: BrowserContext, baseURL: string) {
  // The self answers only mail that arrives after acting is turned on: these two always just arrived.
  const at = () => new Date(Date.now() - 1000).toISOString();
  const threads = (): Record<string, unknown[]> => ({
    "18c2a1f3b4d5e601": [gmailMessage({ id: "s1", threadId: "18c2a1f3b4d5e601", from: "Sam <sam@example.org>", to: "me@example.org", subject: "Lunch", at: at(), text: "CANARY-gmail-sam Are you free for lunch on Friday?" })],
    "18c2a1f3b4d5e602": [gmailMessage({ id: "r1", threadId: "18c2a1f3b4d5e602", from: "Robin <robin@else.example>", to: "me@example.org", subject: "A partnership", at: at(), text: "CANARY-gmail-robin Could we talk next week?" })],
  });
  const consent: URL[] = [];
  const sent: { raw: string; threadId: string }[] = [];
  let signIns = 0;
  const google = fake([
    [
      /oauth2\.googleapis\.com\/token$/,
      () => {
        signIns++;
        return json({ access_token: "ya29.CANARY-access", expires_in: 3599, refresh_token: "1//CANARY-refresh", scope: signIns === 1 ? READ : `${READ} ${SEND}`, token_type: "Bearer" });
      },
    ],
    [/gmail\/v1\/users\/me\/profile$/, () => json({ emailAddress: "me@example.org", historyId: "100" })],
    [/gmail\/v1\/users\/me\/history$/, () => json({ history: [], historyId: "100" })],
    [/gmail\/v1\/users\/me\/threads$/, () => json({ threads: Object.keys(threads()).map((id) => ({ id })) })],
    [/gmail\/v1\/users\/me\/threads\/[^/]+$/, (u) => json({ id: u.pathname.split("/").pop(), historyId: "100", messages: threads()[u.pathname.split("/").pop()!] })],
    [
      /gmail\/v1\/users\/me\/messages\/send$/,
      (_u, init) => {
        const b = JSON.parse(String(init?.body)) as { raw: string; threadId: string };
        sent.push(b);
        return json({ id: `sent-${sent.length}`, threadId: b.threadId });
      },
    ],
  ]);
  await context.route("https://accounts.google.com/**", async (route: Route) => {
    const u = new URL(route.request().url());
    consent.push(u);
    return route.fulfill({ status: 302, headers: { location: `${baseURL}/vault/connect?code=good-code&state=${u.searchParams.get("state")}` } });
  });
  const relay = async (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const res = await google.fetch(req.url(), { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined });
    return route.fulfill({ status: res.status, headers: { ...CORS, "content-type": "application/json" }, body: await res.text() });
  };
  await context.route("https://oauth2.googleapis.com/**", relay);
  await context.route("https://gmail.googleapis.com/**", relay);
  const body = (raw: string) => {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    return Buffer.from(text.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
  };
  return { consent, sent, body };
}

test("the self replies in the owner's Gmail within the thresholds, and a step past them waits for the owner's yes", async ({ page, context, baseURL }) => {
  await installWallet(context);
  const wire = recordBodies(page);
  const google = await playGoogle(context, baseURL!);
  await createWithWallet(page);

  await openTab(page, "Limits");
  const inbox = page.getByRole("form", { name: "Inbox and calendar" });
  await inbox.getByLabel(/Answer mail on its own/).check();
  await inbox.getByLabel("Senders", { exact: true }).fill("sam@example.org");
  await inbox.getByRole("button", { name: "Save the thresholds" }).click();
  await expect(inbox.getByText("Thresholds saved.")).toBeVisible();

  await openTab(page, "Sync");
  const form = page.getByRole("form", { name: "Connect a source" });
  await form.getByText("Gmail", { exact: true }).click();
  await form.getByRole("button", { name: "Connect Gmail" }).click();
  const row = page.getByTestId("sync-row");
  await expect(row).toContainText("me@example.org");
  await expect(row.getByLabel(/Let your self act here/)).not.toBeChecked();
  await expect(row).toContainText("it replies to mail that arrives from now on");

  // Turning acting on asks Google again, for sending as well.
  await row.getByLabel(/Let your self act here/).click();
  await expect(row.getByLabel(/Let your self act here/)).toBeChecked();
  expect(google.consent.at(-1)!.searchParams.get("scope")).toBe(`${READ} ${SEND}`);
  await fitsPhone(page, "Sync, acting on");

  // The pass right after a sync looks at what waits for an answer. Whichever pass gets there first acts; a message is never answered twice.
  await row.getByRole("button", { name: "Sync now" }).click();
  await expect.poll(() => google.sent.length, { timeout: 30_000 }).toBe(1);
  await expect(row).toContainText("Since you turned it on: 1 on its own, 1 waiting in Work, 0 refused.");
  expect(google.sent.map((s) => s.threadId)).toEqual(["18c2a1f3b4d5e601"]);
  expect(google.body(google.sent[0].raw)).toMatch(/^Hi Sam,/);

  await openTab(page, "Work");
  const card = page.getByTestId("act-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("A partnership");
  await expect(card).toContainText("Your Gmail, from this vault");
  await card.getByLabel("What it would send next").fill("Hi Robin,\n\nCANARY-gmail-owner Tuesday works.\n\nSam");
  await card.getByRole("button", { name: "Approve and send" }).click();
  await expect(page.getByTestId("act-card")).toHaveCount(0);
  expect(google.sent).toHaveLength(2);
  expect(google.body(google.sent[1].raw)).toContain("CANARY-gmail-owner Tuesday works.");
  await expect(page.getByTestId("act-done").first()).toBeVisible();

  await openTab(page, "Limits");
  await expect(page.getByTestId("receipt")).toHaveCount(2);

  const toSigil = wire.filter((b) => b.includes(baseURL!)).join("\n");
  for (const secret of ["CANARY-access", "CANARY-gmail-sam", "CANARY-gmail-robin", "CANARY-gmail-owner", "sam@example.org"]) expect(toSigil, secret).not.toContain(secret);
});
