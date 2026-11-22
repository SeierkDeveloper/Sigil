// Site-wide settings. Change links and switches here, nowhere else.

export const site = {
  name: "Sigil",
  /** The public address of this site. Set NEXT_PUBLIC_SITE_URL when building for production. */
  url: (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, ""),
  tagline: "Your AI self, owned by you, forever.",
  description:
    "Sigil is a memory vault encrypted on your own device. Claude, ChatGPT, Cursor and other AI apps read it through one connector, only with the permissions you give, and every read goes on a log you can check.",
  githubUrl: "https://github.com/SeierkDeveloper/Sigil",
  /** The X account. */
  xUrl: "https://x.com/SigilVault",
  /** Path to the logo file (for example "/logo.svg"). While null, the header shows the text wordmark. */
  logoSrc: "/logo.png" as string | null,
  /** Set to true once the connector is published to npm; the docs then show the npx command. */
  connectorPublished: true,
  connectorPackage: "sigil-connector",
} as const;

export interface NavItem {
  href: string;
  label: string;
  /** One line under the label in the header menu. */
  text: string;
}

export interface NavGroup {
  label: string;
  /** A line that introduces the group in the header menu. */
  lead: string;
  items: NavItem[];
}

/** The header menus, the phone menu and the footer columns all come from this list. */
export const navGroups: NavGroup[] = [
  {
    label: "Product",
    lead: "One encrypted memory, read by every AI app you use, only where you allow it.",
    items: [
      { href: "/vault", label: "Vault", text: "Memories, folders, apps and the read log" },
      { href: "/docs#inbox", label: "Inbox", text: "Memories your apps suggest, kept only if you approve" },
      { href: "/import", label: "Import", text: "Bring your ChatGPT and Claude history" },
      { href: "/apps", label: "Apps", text: "Step-by-step setup for every AI app" },
      { href: "/docs#extension", label: "Extension", text: "Save a selection, a page or a chat from the browser" },
      { href: "/docs#sharing", label: "Sharing", text: "One folder, read by another vault you trust" },
      { href: "/legacy", label: "Legacy", text: "Who receives your vault, and only when" },
      { href: "/docs#devices", label: "Phone and devices", text: "Install it, add a device by QR code, capture into the inbox" },
      { href: "/docs#sync", label: "Live sync", text: "Gmail, Calendar, Drive and Slack, kept in sync on your device" },
      { href: "/seals", label: "Seals", text: "The hourly seals, with a proof checker" },
    ],
  },
  {
    label: "Trust",
    lead: "What Sigil can see, what it cannot, and how you can check.",
    items: [
      { href: "/how-it-works", label: "How it works", text: "From sign-up to a sealed read, in plain words" },
      { href: "/security", label: "Security", text: "Keys, encryption and what the server holds" },
      { href: "/threat-model", label: "Threat model", text: "What Sigil protects against, and what it does not" },
      { href: "/immune", label: "Immune system", text: "Hidden instructions caught, attacked every hour in public" },
      { href: "/privacy", label: "Privacy", text: "What is stored, and for how long" },
      { href: "/status", label: "Status", text: "Live health of the service and the seal job" },
    ],
  },
  {
    label: "Developers",
    lead: "Open source, a small read-only API and one connector for every MCP client.",
    items: [
      { href: "/docs", label: "Docs", text: "Quick start and the encryption model" },
      { href: "/docs/api", label: "API reference", text: "Every public and connector endpoint" },
      { href: "/spec", label: "Open standard", text: "The formats, keys, tools and log, with test vectors" },
      { href: "/connector", label: "Connector", text: "The MCP server, its tools and settings" },
      { href: "/docs#sign-in-with-sigil", label: "Sign in with Sigil", text: "Let a web app read the folders its user picks" },
      { href: "/docs#agents", label: "Agent vaults", text: "A memory of their own for Cursor, Claude Code and other agents" },
      { href: "/verify", label: "Verify", text: "Check a seal, a certificate, a proof, an agreement or a pack" },
      { href: "/open-source", label: "Open source", text: "The repository, the licence, run it yourself" },
    ],
  },
  {
    label: "Vision",
    lead: "Where this goes: from a vault to an AI self that is yours.",
    items: [
      { href: "/ai-self", label: "The AI self", text: "The long-term idea, told as a story" },
      { href: "/roadmap", label: "Roadmap", text: "Ten stages ahead, from Next to Vision" },
      { href: "/changelog", label: "Changelog", text: "What has been built so far" },
      // The token's page: always in the menu. Its label is the ticker only once it is live (set at build time, see server/token.ts).
      { href: "/token", label: (process.env.NEXT_PUBLIC_SIGIL_TOKEN === "on" && process.env.NEXT_PUBLIC_SIGIL_TOKEN_SYMBOL) || "Token", text: "Bought back and burned, every half hour" },
    ],
  },
];

export const legalNav = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/status", label: "Status" },
] as const;
