// The wallet button with no wallet in the browser: on a phone it must open the
// page inside the wallet app; on a computer it must open the wallet download page.

import { expect, test, devices } from "@playwright/test";

test.describe("phone without a wallet", () => {
  const { defaultBrowserType: _ignored, ...phone } = devices["Pixel 7"];
  test.use(phone);

  test("opens the page in the wallet app, keeping the path", async ({ page }) => {
    await page.route("https://metamask.app.link/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>wallet app</p>" }));
    await page.goto("/vault#memories");
    const nav = page.waitForRequest((r) => r.url().startsWith("https://metamask.app.link/dapp/") && r.isNavigationRequest());
    await page.getByTestId("method-wallet").click();
    const req = await nav;
    expect(req.url()).toContain("https://metamask.app.link/dapp/localhost:3210/vault");
    await expect(page).toHaveURL("https://metamask.app.link/dapp/localhost:3210/vault#memories");
  });
});

test.describe("computer without a wallet", () => {
  test("opens the wallet download page and says why", async ({ page, context }) => {
    await context.route("https://metamask.io/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>download</p>" }));
    await page.goto("/vault");
    const popup = context.waitForEvent("page");
    await page.getByTestId("method-wallet").click();
    expect((await popup).url()).toContain("https://metamask.io/download");
    await expect(page.locator(".notice-error")).toContainText("No wallet was found in this browser");
  });
});
