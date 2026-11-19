// Server settings, all from the environment, all with safe defaults.

function flag(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "on" || v === "1" || v === "true" || v === "yes";
}

export const serverConfig = {
  /** The public origin, for example https://example.com. When unset, the request's own origin is used (local use). */
  get origin(): string | undefined {
    return process.env.SIGIL_ORIGIN?.replace(/\/$/, "") || undefined;
  },
  /** Length of one seal period in seconds. 3600 (one hour) in production; tests shorten it. */
  get sealSeconds(): number {
    const n = Number(process.env.SIGIL_SEAL_SECONDS);
    return Number.isInteger(n) && n >= 1 && n <= 86400 ? n : 3600;
  },
  /** Local hourly sealing of the read log. On by default. */
  get sealsEnabled(): boolean {
    return flag("SIGIL_SEALS", true);
  },
  /** Publishing seal roots to the SigilSeal contract. Off by default. */
  get anchorEnabled(): boolean {
    return flag("SIGIL_ANCHOR", false);
  },
  get anchor() {
    return {
      rpcUrl: process.env.SIGIL_ANCHOR_RPC_URL || "",
      contract: process.env.SIGIL_SEAL_CONTRACT || "",
      sealerKey: process.env.SIGIL_SEALER_KEY || "",
    };
  },
  sessionDays: 30,
};
