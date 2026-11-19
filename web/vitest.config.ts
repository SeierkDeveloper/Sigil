import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 3,
    env: { SIGIL_SEALS: "on", SIGIL_ANCHOR: "off" },
  },
});
