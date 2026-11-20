// Runs once when the server starts. Seals finished hours of the read log on a
// timer (requests also seal lazily), deletes expired memories whose grace
// period is over, writes the legacy warning stages the owners reached, and
// publishes seals on chain only when anchoring is on. It also makes heirs of
// shared memories members once a plan released, and deletes vaults that moved
// to another node once their period of sending links on is over.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getDb } = await import("./server/db");
  const { sealPending } = await import("./server/seal");
  const { anchorPending, anchorStatus } = await import("./server/anchor");
  const { serverConfig } = await import("./server/config");
  const { purgeExpired } = await import("./server/store");
  const { cleanQuestions } = await import("./server/self");
  const { legacyTick } = await import("./server/legacy");
  const { moveTick } = await import("./server/nodes");
  const { heirsTick } = await import("./server/spaces");

  const tick = async () => {
    try {
      const db = getDb();
      sealPending(db);
      // Memories past their grace period after expiry are deleted for real; old relay boxes go too.
      purgeExpired(db);
      cleanQuestions(db);
      legacyTick(db);
      // Heirs of shared memories whose member's plan released; vaults that moved away and whose period is over.
      heirsTick(db);
      moveTick(db);
      db.prepare("DELETE FROM device_pairings WHERE expires_at < ?").run(Date.now());
      if (anchorStatus().mode === "anchored") await anchorPending(db);
    } catch (err) {
      console.error("[sigil] seal job failed", err);
    }
  };
  const every = Math.min(serverConfig.sealSeconds * 1000, 5 * 60_000);
  const timer = setInterval(tick, every);
  timer.unref?.();
  void tick();
}
