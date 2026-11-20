import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// The page may only talk to its own server, plus three addresses the owner's own
// browser calls directly with the owner's own keys: the two model providers the
// AI self can use, and GitHub for the import. Nothing is sent there unless the
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

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isProd ? "" : " 'unsafe-eval'"}`,
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' https://api.anthropic.com https://api.openai.com https://api.github.com${chainRead}${isProd ? "" : " ws: wss:"}`,
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
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)" },
          ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
