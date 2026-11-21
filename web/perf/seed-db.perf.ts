// `npm run seed`: writes a big vault to a database file a node can open, and
// prints the recovery phrase to sign in with (on the vault page, "Recovery
// phrase"). Sizes as in seed.ts; SIGIL_PERF_MEMORIES sets the number of
// memories, SIGIL_SEED_FILE the file (default web/.data-seed/sigil.db). Start a
// node on it with SIGIL_DATA_DIR=web/.data-seed and a port other than the usual one.

import { it } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { harness } from "../test/helpers";
import { seedVault } from "./seed";

it("writes a big vault to a file", async () => {
  const file = path.resolve(process.env.SIGIL_SEED_FILE ?? path.join(import.meta.dirname, "../.data-seed/sigil.db"));
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) rmSync(file);
  const h = harness();
  const n = Number(process.env.SIGIL_PERF_MEMORIES ?? 100_000);
  const s = await seedVault(h, { memories: n, onProgress: (what, done, total) => process.stdout.write(`${what}: ${done}/${total}\n`) });
  h.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  process.stdout.write(`\nWrote ${n.toLocaleString("en-US")} memories to ${file}\nRecovery phrase:\n${s.phrase}\n`);
});
