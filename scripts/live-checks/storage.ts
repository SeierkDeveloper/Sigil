// The owner's own storage for backups: put a small test file, read it back
// through its public address, compare. The target is a JSON file in the shape
// of the vault's Storage form (see docs/GO-LIVE-CHECKS.md). Keys are never printed.
import { readFileSync } from "node:fs";
import { backendFor, cleanTarget, randomBytes, toHex } from "../../packages/core/src";
import { ask, bad, done, note, ok } from "./lib";

const file = await ask("SIGIL_CHECK_TARGET_FILE", "Path to the storage target JSON");
const target = cleanTarget(JSON.parse(readFileSync(file, "utf8")));
note(`kind ${target.kind}, label ${target.label}`);
const bytes = randomBytes(1024);
const name = `sigil-live-check-${toHex(randomBytes(6))}.bin`;
const backend = backendFor(target, (i, init) => fetch(i, init));
try {
  const place = await backend.put(bytes, name);
  ok("put", `${place.kind} ${place.ref.slice(0, 60)}${place.url ? `, public at ${place.url.split("?")[0]}` : ""}`);
  const back = await backend.get(place.ref);
  back.length === bytes.length && back.every((b, i) => b === bytes[i]) ? ok("get, the same bytes") : bad("get", `got ${back.length} bytes`);
} catch (err) {
  bad("storage", (err as Error).message);
}
note("Delete the test object by hand if the storage keeps it (Arweave keeps it for good: use a test wallet with a tiny balance).");
done();
