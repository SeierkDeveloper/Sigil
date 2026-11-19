// Runs once when the server starts. Seals finished hours of the read log on a
// timer (requests also seal lazily), and publishes seals on chain only when
// anchoring is switched on.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getDb } = await import("./server/db");
  const { sealPending } = await import("./server/seal");
  const { anchorPending, anchorStatus } = await import("./server/anchor");
  const { serverConfig } = await import("./server/config");

  const tick = async () => {
    try {
      const db = getDb();
      sealPending(db);
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
