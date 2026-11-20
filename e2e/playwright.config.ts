import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const PORT = 3210;
export const BASE_URL = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), "sigil-e2e-"));

/** Search by meaning runs on a tiny model kept in the repository, so no test touches the network. */
export const TEST_MODEL = { SIGIL_EMBED_MODEL: "sigil/tiny-embedder", SIGIL_MODEL_DIR: path.resolve(import.meta.dirname, "../packages/core/test/fixtures/tiny-model"), SIGIL_MODEL_FETCH: "off" };

export default defineConfig({
  testDir: "tests",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    channel: "chrome",
    headless: true,
    trace: "off",
  },
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npm run start -w @sigil/web`,
    cwd: path.resolve(import.meta.dirname, ".."),
    url: `${BASE_URL}/api/status`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      SIGIL_DATA_DIR: dataDir,
      SIGIL_SEAL_SECONDS: "4",
      SIGIL_SEALS: "on",
      SIGIL_ANCHOR: "off",
      ...TEST_MODEL,
    },
  },
});
