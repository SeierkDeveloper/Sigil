// Site-wide settings. Change links and switches here, nowhere else.

export const site = {
  name: "Sigil",
  /** The public address of this site. Set NEXT_PUBLIC_SITE_URL when building for production. */
  url: (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, ""),
  tagline: "Your AI self, owned by you, forever.",
  description:
    "Sigil is a memory vault encrypted on your own device. Claude, ChatGPT, Cursor and other AI apps read it through one connector, only with the permissions you give, and every read goes on a log you can check.",
  githubUrl: "https://github.com/SeierkDeveloper/Sigil",
  /** The X account. Fill in the handle when it exists. */
  xUrl: "https://x.com/",
  /** Path to the logo file (for example "/logo.svg"). While null, the header shows the text wordmark. */
  logoSrc: null as string | null,
  /** Set to true once the connector is published to npm; the docs then show the npx command. */
  connectorPublished: false,
  connectorPackage: "sigil-connector",
} as const;

export const nav = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/security", label: "Security" },
  { href: "/docs", label: "Docs" },
  { href: "/roadmap", label: "Roadmap" },
] as const;

export const footerNav = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/security", label: "Security" },
  { href: "/docs", label: "Docs" },
  { href: "/roadmap", label: "Roadmap" },
  { href: "/vault", label: "Vault" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
] as const;
