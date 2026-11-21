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
  const { immuneTick } = await import("./server/immune");

  // Clear words at start for the two mistakes that break a hosted node quietly.
  if (process.env.NODE_ENV === "production" && !serverConfig.origin) {
    console.warn("[sigil] SIGIL_ORIGIN is not set: passkeys and same-origin checks follow the request's Host header. Set it to the public address, such as https://sigilvault.fun.");
  }
  try {
    const { dataFile } = await import("./server/db");
    const { accessSync, mkdirSync, constants } = await import("node:fs");
    const dir = (await import("node:path")).dirname(dataFile());
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (err) {
    console.error(`[sigil] The data folder cannot be written (${(err as Error).message}). On Railway, set RAILWAY_RUN_UID=0 so the volume at /data is writable.`);
  }

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
      // The immune system's public test, once an hour, when it is switched on.
      await immuneTick(db).catch((err) => console.error("[sigil] immune round failed", err));
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
