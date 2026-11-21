// The performance check: a big vault, timed. Not part of npm test (see docs/PERFORMANCE.md).
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["perf/**/*.perf.ts"],
    pool: "forks",
    maxWorkers: 1,
    testTimeout: 30 * 60_000,
    hookTimeout: 30 * 60_000,
    env: { SIGIL_SEALS: "on", SIGIL_ANCHOR: "off" },
  },
});
