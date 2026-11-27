// A self that acts, in a real browser with the real connector over MCP: the
// owner sets thresholds and ranges under Limits and lets an app ask first; the
// app checks before it acts, a step past the thresholds waits in Work with the
// thread, the owner changes the text and says yes, the app reads that yes and
// reports, and the receipt shows under Limits. A negotiation at the edge of a
// range waits too. Nothing readable leaves the browser or the connector.

import { expect, test } from "@playwright/test";
import { connectApp, connectMcp, createWithWallet, fitsPhone, installWallet, openTab, recordBodies, textOf } from "./helpers";

const CANARY = "CANARY-acting-e2e-71d3";

test("an app asks before it acts, a step waits in Work, the owner says yes with their own text, and a receipt is kept", async ({ page, context, baseURL }) => {
  await installWallet(context);
  const sent = recordBodies(page);
  await createWithWallet(page);
  const appKey = await connectApp(page, { name: "Claude Desktop", folders: ["Notes"] });

  // ---- thresholds and ranges, kept encrypted
  await openTab(page, "Limits");
  const inbox = page.getByRole("form", { name: "Inbox and calendar" });
  await inbox.getByLabel(/Answer mail on its own/).check();
  await inbox.getByLabel("Senders").fill("sam@example.org");
  await inbox.getByLabel("Never touch").fill("lawyer");
  await inbox.getByRole("button", { name: "Save the thresholds" }).click();
  await expect(inbox.getByText("Thresholds saved.")).toBeVisible();
  await expect(inbox.locator(".plate-state")).toHaveText("1 of 2 on");

  const ranges = page.getByRole("form", { name: "Ranges for negotiating" });
  await ranges.getByLabel(/Negotiate within these ranges on its own/).check();
  await ranges.getByRole("button", { name: "Add a price range" }).click();
  await ranges.getByLabel("What it is for").fill("Consulting day");
  await ranges.getByLabel("Lowest").fill("800");
  await ranges.getByLabel("Highest").fill("1200");
  await ranges.getByLabel("Currency").fill("EUR");
  await ranges.getByRole("button", { name: "Save the ranges" }).click();
  await expect(ranges.getByText("Ranges saved.")).toBeVisible();

  // ---- the app may act
  const apps = page.getByRole("region", { name: "Apps that ask first" });
  await apps.getByLabel("May act within your limits").check();
  await expect(apps.locator(".plate-state")).toHaveText("1 app");
  await fitsPhone(page, "Limits");

  const mcp = await connectMcp(appKey, baseURL!);
  expect(textOf(await mcp.callTool({ name: "get_thresholds", arguments: {} }))).toContain("Mail: it may reply to sam@example.org");
  const ok = textOf(await mcp.callTool({ name: "check_action", arguments: { area: "mail", action: "reply", who: "Sam <sam@example.org>", subject: "Lunch", text: "Free on Friday?" } }));
  expect(ok).toContain("allowed: you may go ahead");
  const okId = /Step id: ([A-Za-z0-9_-]+)/.exec(ok)![1];
  const held = textOf(
    await mcp.callTool({
      name: "check_action",
      arguments: { area: "mail", action: "reply", who: "Robin <robin@else.example>", subject: "Partnership", text: `Could we talk next week? ${CANARY}-thread`, next: "Sure, next week works." },
    }),
  );
  expect(held).toContain("needs-approval: The other person is not one of the senders you listed.");
  const heldId = /Step id: ([A-Za-z0-9_-]+)/.exec(held)![1];
  const edge = textOf(await mcp.callTool({ name: "negotiate", arguments: { kind: "price", topic: "Consulting day", who: "Kim", theirs: { price: "700" } } }));
  expect(edge).toContain("ask: Their offer of 700 EUR is below the lowest you set (800 EUR).");

  // ---- Work shows what waits, with the thread
  await page.reload();
  await page.getByTestId("method-wallet").click();
  await expect(page.getByRole("heading", { name: "Your vault", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Work/ }).locator(".tab-count")).toHaveText("2");
  await openTab(page, "Work");
  const card = page.getByTestId("act-card").filter({ hasText: "Partnership" });
  await expect(card).toContainText("Claude Desktop");
  await expect(card).toContainText("The other person is not one of the senders you listed.");
  await card.getByText(/The thread/).click();
  await expect(card).toContainText(`${CANARY}-thread`);
  await card.getByLabel("What it would send next").fill(`Happy to talk on Tuesday. ${CANARY}-owner`);
  await card.getByRole("button", { name: "Approve and send" }).click();
  await expect(page.getByTestId("act-card").filter({ hasText: "Partnership" })).toHaveCount(0);
  const offer = page.getByTestId("act-card").filter({ hasText: "Consulting day" });
  await expect(offer).toContainText("800 EUR");
  await offer.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByTestId("act-card")).toHaveCount(0);
  await fitsPhone(page, "Work");

  // ---- the app reads the yes, acts, and reports
  expect(textOf(await mcp.callTool({ name: "check_action", arguments: { id: heldId } }))).toContain(`Send exactly this:\n\nHappy to talk on Tuesday. ${CANARY}-owner`);
  expect(textOf(await mcp.callTool({ name: "report_action", arguments: { id: heldId, what: "Replied to Robin about Tuesday" } }))).toContain("Kept a signed receipt");
  expect(textOf(await mcp.callTool({ name: "report_action", arguments: { id: okId, what: "Replied to Sam about lunch" } }))).toContain("Kept a signed receipt");
  await mcp.close();

  // ---- the receipts, signed by the app's key under the self key's word
  await openTab(page, "Limits");
  const receipts = page.getByTestId("receipt");
  await expect(receipts).toHaveCount(2);
  await expect(receipts.first()).toContainText("Signed by Claude Desktop under your self key's word.");
  await expect(page.getByTestId("receipt").filter({ hasText: "Replied to Sam about lunch" })).toContainText("Mail");

  const wire = sent.filter((b) => b.includes(baseURL!)).join("\n");
  for (const plain of [`${CANARY}-owner`, "sam@example.org", "Consulting day"]) expect(wire, plain).not.toContain(plain);
});
