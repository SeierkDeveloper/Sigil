import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// Live sync: the owner's browser talks to these with the owner's own sign-in.
// Nothing is sent there unless the owner connects a source. Kept in step with
// SYNC_ORIGINS in packages/core/src/sync/oauth.ts (a test checks it).
const SYNC_ORIGINS = ["https://oauth2.googleapis.com", "https://gmail.googleapis.com", "https://www.googleapis.com", "https://slack.com"];

// The page may only talk to its own server, plus the addresses the owner's own
// browser calls directly with the owner's own keys: the two model providers the
// AI self can use, GitHub for the import, and the services of live sync. Nothing is sent there unless the
// owner sets a model key or starts a GitHub import. No third-party scripts,
// styles, fonts or frames. Next.js needs inline scripts for hydration; dev mode also needs eval.
// 'wasm-unsafe-eval' lets the vault run the search model (WebAssembly) it loads
// from this same site; it does not allow eval of JavaScript.
// When the seals are anchored and a public read-only address is set, the verify
// page reads roots from the contract in the visitor's browser: that one origin
// is added. Nothing is sent there but the hours being checked.
const chainRead = (() => {
  try {
    const v = process.env.SIGIL_CHAIN_READ_RPC?.trim();
    return v && v.startsWith("https://") ? ` ${new URL(v).origin}` : "";
  } catch {
    return "";
  }
})();

// The same for the chain of the registry of AI selves: when its public read
// address is set, the vault reads a self wallet's spends from it.
const identityRead = (() => {
  try {
    const v = process.env.SIGIL_IDENTITY_READ_RPC?.trim();
    return v && v.startsWith("https://") ? ` ${new URL(v).origin}` : "";
  } catch {
    return "";
  }
})();

// Backups: the owner's own device uploads ciphertext to the owner's own storage
// with the owner's own tokens. These are the storage addresses the page may
// talk to: common S3-compatible hosts, IPFS pinning and Arweave upload
// addresses, plus any the node lists in SIGIL_BACKUP_ORIGINS (space separated,
// https only; read at build time). Nothing is sent there unless the owner adds
// that storage under Storage. Restoring never needs this: the node fetches.
const BACKUP_ORIGINS = [
  "https://*.amazonaws.com",
  "https://*.r2.cloudflarestorage.com",
  "https://*.backblazeb2.com",
  "https://*.digitaloceanspaces.com",
  "https://*.wasabisys.com",
  "https://s3.filebase.com",
  "https://api.pinata.cloud",
  "https://upload.ardrive.io",
  "https://*.irys.xyz",
];
const backupOrigins = (() => {
  const extra = (process.env.SIGIL_BACKUP_ORIGINS ?? "")
    .split(/\s+/)
    .map((v) => v.trim())
    .filter((v) => /^https:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(v) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(v));
  return [...BACKUP_ORIGINS, ...extra].join(" ");
})();

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isProd ? "" : " 'unsafe-eval'"}`,
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' https://api.anthropic.com https://api.openai.com https://api.github.com ${SYNC_ORIGINS.join(" ")} ${backupOrigins}${chainRead}${identityRead}${isProd ? "" : " ws: wss:"}`,
  "media-src 'self' blob:",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@sigil/core"],
  experimental: { cpus: 3 },
  serverExternalPackages: ["@simplewebauthn/server"],
  // The public AI self lives at /@handle.
  async rewrites() {
    return [{ source: "/@:handle", destination: "/u/:handle" }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          // The camera is allowed for this site only: the vault reads a device's pairing code with it, on this page.
          // The microphone too, for voice: what it hears is turned into text on the device and never sent.
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)" },
          ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
