// Seals every finished hour of the read log now, then publishes on chain if
// anchoring is switched on. Usage: npm run seal -w @sigil/web
import { getDb } from "../src/server/db.ts";
import { sealPending } from "../src/server/seal.ts";
import { anchorPending, anchorStatus } from "../src/server/anchor.ts";

const db = getDb();
const made = sealPending(db);
console.log(`Sealed ${made.length} hour(s).`);
const status = anchorStatus();
if (status.mode === "anchored") {
  const tx = await anchorPending(db);
  console.log(tx ? `Anchored in ${tx}.` : "Nothing to anchor.");
} else {
  console.log(`Seals stay local: ${status.reason}`);
}
