// Passkeys with the PRF extension, on Chrome's virtual authenticator: create a
// vault, lock it, unlock it with the passkey, then open it with the recovery phrase.

import { expect, test } from "@playwright/test";
import { confirmPhrase } from "./helpers";

test("passkey sign-up, unlock and recovery phrase", async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.goto("/vault");
  await page.getByTestId("method-passkey").click();
  const words = page.getByTestId("recovery-phrase").locator("li");
  await expect(words).toHaveCount(24);
  const phrase = (await words.allInnerTexts()).map((w) => w.trim()).join(" ");
  await confirmPhrase(page, phrase);
  await page.getByRole("button", { name: "Open my vault" }).click();

  await page.getByRole("button", { name: "Write a memory" }).click();
  await page.getByLabel("Title").fill("Passkey memory");
  await page.getByLabel("Memory", { exact: true }).fill("Stored with a key from the passkey PRF.");
  await page.getByRole("button", { name: "Save memory" }).click();
  await expect(page.locator(".memory-item-title")).toHaveText(["Passkey memory"]);

  // Settings lists both ways in.
  await openTab(page, "Settings");
  await expect(page.locator(".settings .list-row-title")).toHaveText(["Passkey", "Recovery phrase"]);

  // Reload locks the vault; the passkey unlocks it again.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Unlock your vault" })).toBeVisible();
  await page.getByTestId("method-passkey").click();
  await openTab(page, "Memories");
  await expect(page.locator(".memory-item-title")).toHaveText(["Passkey memory"]);

  // Sign out, then open the same vault with only the recovery phrase.
  await openTab(page, "Settings");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to your vault" })).toBeVisible();
  await page.getByTestId("method-phrase").click();
  await page.getByLabel("Recovery phrase").fill(phrase);
  await page.getByRole("button", { name: "Unlock with phrase" }).click();
  await openTab(page, "Memories");
  await expect(page.locator(".memory-item-title")).toHaveText(["Passkey memory"]);
});
