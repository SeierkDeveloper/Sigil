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
  /** Search by meaning in the vault. The model runs in the browser; the server only hands out its files. On by default. */
  get semanticEnabled(): boolean {
    return flag("SIGIL_SEMANTIC", true);
  },
  /** The sentence model the vault page loads. */
  get embedModel(): string {
    return process.env.SIGIL_EMBED_MODEL?.trim() || "Xenova/all-MiniLM-L6-v2";
  },
  /** Where model files are kept. Defaults to models/ in the data folder. */
  get modelDir(): string | undefined {
    return process.env.SIGIL_MODEL_DIR?.trim() || undefined;
  },
  /** Fetch a missing model file from the public model hub once and keep it. Turn off to serve only what is on disk. */
  get modelFetch(): boolean {
    return flag("SIGIL_MODEL_FETCH", true);
  },
  /** How long the owner's agent counts as online after it last checked in for questions (seconds). 30 by default; tests shorten it. */
  get agentOnlineMs(): number {
    const n = Number(process.env.SIGIL_AGENT_ONLINE_SECONDS);
    return (Number.isInteger(n) && n >= 2 && n <= 600 ? n : 30) * 1000;
  },
  /** The length of one day for legacy plans, in milliseconds. A real day unless tests shorten it. */
  get legacyDayMs(): number {
    const n = Number(process.env.SIGIL_LEGACY_DAY_MS);
    return Number.isFinite(n) && n >= 1 && n <= 86_400_000 ? n : 86_400_000;
  },
  /**
   * A public, read-only RPC address for the chain the seals are anchored on.
   * When set together with SIGIL_SEAL_CONTRACT, the verify page reads roots
   * from the contract in the visitor's browser. It never carries a key.
   */
  get chainReadRpc(): string {
    const v = process.env.SIGIL_CHAIN_READ_RPC?.trim() || "";
    return /^https:\/\/[^\s]+$/.test(v) ? v : "";
  },
  /**
   * Public OAuth client ids for live sync, from the environment. They are not
   * secrets: the flow runs on the owner's device with PKCE, and no client
   * secret is ever set on the server. Unset, a source shows how to add one.
   */
  get syncClients(): { google: string | null; slack: string | null } {
    const clean = (v: string | undefined) => {
      const t = v?.trim() ?? "";
      return /^[A-Za-z0-9._-]{6,200}$/.test(t) ? t : null;
    };
    return { google: clean(process.env.SIGIL_GOOGLE_CLIENT_ID), slack: clean(process.env.SIGIL_SLACK_CLIENT_ID) };
  },
  /**
   * The registry of AI selves (contracts/src/SigilSelfRegistry.sol) and the
   * chain it lives on, once the owner of the site deployed it. Null until both
   * a chain id and an address are set: the Identity tab then works off chain.
   * The read address is public and read-only; the browser reads a self wallet's
   * spends through it. No key is ever set here: registering is sent by the
   * vault owner's own wallet.
   */
  get identityChain(): { chainId: string; registry: string; rpcUrl: string } | null {
    const chainId = process.env.SIGIL_IDENTITY_CHAIN_ID?.trim() ?? "";
    const registry = process.env.SIGIL_IDENTITY_REGISTRY?.trim() ?? "";
    if (!/^[1-9]\d{0,17}$/.test(chainId) || !/^0x[0-9a-fA-F]{40}$/.test(registry)) return null;
    const rpc = process.env.SIGIL_IDENTITY_READ_RPC?.trim() ?? "";
    return { chainId, registry, rpcUrl: /^https:\/\/[^\s]+$/.test(rpc) ? rpc : "" };
  },
  sessionDays: 30,
};
