// Screenshots of every page and vault state, at real desktop and phone sizes.
// Run: npx playwright test -c playwright.shots.config.ts (from e2e/), after npm run build.
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testDir: "shots",
  timeout: 300_000,
  projects: [{ name: "shots", use: { channel: "chrome" } }],
  webServer: { ...(base.webServer as object), env: { ...((base.webServer as { env: Record<string, string> }).env), SIGIL_SEAL_SECONDS: "60" } } as never,
});
