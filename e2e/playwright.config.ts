import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const PORT = 3210;
export const BASE_URL = `http://localhost:${PORT}`;
/** A second node, for restoring a bundle on another node and moving a vault between two. */
export const SECOND_PORT = 3211;
export const SECOND_URL = `http://localhost:${SECOND_PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), "sigil-e2e-"));
const secondDir = mkdtempSync(path.join(tmpdir(), "sigil-e2e-second-"));

/** Search by meaning and voice run on tiny models kept in the repository, so no test touches the network or runs a real model. */
export const TEST_MODEL = {
  SIGIL_EMBED_MODEL: "sigil/tiny-embedder",
  SIGIL_SPEECH_MODEL: "sigil/tiny-whisper.en",
  SIGIL_MODEL_DIR: path.resolve(import.meta.dirname, "../packages/core/test/fixtures/tiny-model"),
  SIGIL_MODEL_FETCH: "off",
};

const serverEnv = (port: number, dir: string) => ({
  PORT: String(port),
  SIGIL_DATA_DIR: dir,
  SIGIL_SEAL_SECONDS: "4",
  SIGIL_SEALS: "on",
  SIGIL_ANCHOR: "off",
  SIGIL_AGENT_ONLINE_SECONDS: "6",
  // A legacy day of 25 ms: a three-month period passes in about two seconds.
  SIGIL_LEGACY_DAY_MS: "25",
  // Public client ids for live sync. The providers themselves are played by the tests.
  SIGIL_GOOGLE_CLIENT_ID: "e2e-client.apps.googleusercontent.com",
  SIGIL_SLACK_CLIENT_ID: "1234.5678",
  // The two nodes run on this machine and talk to each other over localhost.
  SIGIL_NODE_ALLOW_PRIVATE: "on",
  // The immune system's public test, against the deterministic test model: no call leaves the node.
  SIGIL_IMMUNE_MODEL: "stub",
  ...TEST_MODEL,
});

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
  webServer: [
    {
      command: `npm run start -w @sigil/web`,
      cwd: path.resolve(import.meta.dirname, ".."),
      url: `${BASE_URL}/api/status`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: serverEnv(PORT, dataDir),
    },
    {
      command: `npm run start -w @sigil/web`,
      cwd: path.resolve(import.meta.dirname, ".."),
      url: `${SECOND_URL}/api/status`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: serverEnv(SECOND_PORT, secondDir),
    },
  ],
});
