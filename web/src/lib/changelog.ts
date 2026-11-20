// What has been built, newest first. Add an entry with every release.

export interface Release {
  date: string; // ISO day
  title: string;
  summary: string;
  area: "Site" | "Vault" | "Connector" | "Seals" | "Core" | "Inbox" | "Search" | "Extension" | "SDK" | "Sharing" | "AI self" | "Import";
  items: string[];
}

export const releases: Release[] = [
  {
    date: "2026-11-20",
    title: "Your AI self, version 1",
    area: "AI self",
    summary: "An AI that answers as you, from the folders you choose and within rules you write, with your own model key. Share it with a link.",
    items: [
      "Rules: the folders it may use, topics it may and may not discuss, things it must never say, its tone, and what it says when it does not know",
      "Your own Anthropic or OpenAI key, encrypted in the vault and used only from your browser or the connector on your machine",
      "A test chat in the vault that shows the memories each answer used",
      "Ask links with their own rules, an expiry, a number of questions and an hourly limit; questions and answers are end to end encrypted between the asker's browser and your open vault or connector",
      "When neither is running the link says your AI self is offline, and every question and answer goes into your read log, sealed",
      "ask_self in the connector for apps you allow, and sigil-connector --self to answer links while your vault is closed",
    ],
  },
  {
    date: "2026-11-20",
    title: "Memory that thinks",
    area: "Vault",
    summary: "A weekly brief, memories that disagree, every duplicate group merged at once, and memories that expire.",
    items: [
      "A weekly brief of what is new, what changed and what you may have forgotten, saved in a Briefs folder; written by your model when you allow it, as plain lists otherwise",
      "Pairs of memories that seem to disagree, found by meaning and by words, with an optional check by your model",
      "Merge every duplicate group after one approval",
      "An expiry date per memory: expired memories leave the list and apps, wait under Expired, and are deleted for real after a grace period you set",
    ],
  },
  {
    date: "2026-11-20",
    title: "Your whole digital life, imported on your device",
    area: "Import",
    summary: "Obsidian, Apple Notes, Gmail and Google Calendar, Notion and GitHub, parsed and encrypted in the browser. No app approvals.",
    items: [
      "Obsidian vaults with their tags, kept in sync by the connector watching the folder and suggesting changes through the inbox",
      "Apple Notes from the iCloud data copy or exported files",
      "Google Takeout: one memory per mail thread within size limits, one per calendar event",
      "Notion Markdown exports, zip inside zip included",
      "A GitHub repository's history or your recent activity, asked from the browser with a token that is never saved",
      "A preview, a folder choice and dedupe against what is already in the vault for every source",
    ],
  },
  {
    date: "2026-11-20",
    title: "The memory inbox",
    area: "Inbox",
    summary: "Apps can suggest what to remember. Nothing becomes a memory until you approve it.",
    items: [
      "Every vault gets an X25519 key pair; its private half is wrapped by the vault key",
      "A per-app switch, off by default: May suggest memories to your inbox",
      "propose_memory in the connector seals each suggestion on your computer, after checking a tag your vault made for that app",
      "An Inbox tab to edit, approve into a folder, merge into a memory or reject, with a hint when it is already in the vault",
      "Suggestions in the read log, 30 per app per hour, up to 500 waiting",
    ],
  },
  {
    date: "2026-11-20",
    title: "Memory that understands",
    area: "Search",
    summary: "Search by meaning, run on your device, and the first tools that help keep a vault in order.",
    items: [
      "A small sentence model on WebAssembly, in a worker in the vault and in the connector, never on the server",
      "Hybrid search by words and meaning in the vault and in search_memories",
      "Vectors kept in the browser only encrypted, under names that do not show the text",
      "Duplicates: the same text, nearly the same words or the same meaning, merged in one step",
      "A Timeline by date written or last changed, filtered by source",
      "The Self card, a short profile in its own folder, read by apps through get_profile",
    ],
  },
  {
    date: "2026-11-20",
    title: "The browser extension",
    area: "Extension",
    summary: "Save a selection, a page or a whole ChatGPT or Claude conversation to your inbox, sealed in the browser.",
    items: [
      "Chrome, Manifest V3, built as an unpacked extension",
      "Paired by an app key made under Apps; it checks the vault public key before sealing",
      "Right-click menu, a toolbar popup, and a small button on chatgpt.com and claude.ai",
    ],
  },
  {
    date: "2026-11-20",
    title: "Sign in with Sigil",
    area: "SDK",
    summary: "Web apps can ask for read access to the folders you choose.",
    items: [
      "A consent window in the vault that answers only the page that asked",
      "The @sigil/sdk package: requestAccess, then folders, search, read, the Self card and suggestions, decrypted in the browser",
      "An example app in examples/hello-sigil",
    ],
  },
  {
    date: "2026-11-20",
    title: "Sharing between vaults",
    area: "Sharing",
    summary: "Share a folder with another Sigil vault, read only, and take it back.",
    items: [
      "Vault codes with a fingerprint to compare",
      "Folder keys sealed to the other vault's public key; accept or decline on their side",
      "Every opening of a shared folder in the owner's read log",
      "Stop sharing gives the folder a new key and encrypts it again on the owner's device",
    ],
  },
  {
    date: "2026-11-20",
    title: "The full site, live numbers and public proofs",
    area: "Site",
    summary: "Sigil's site grows from a landing page into the whole product: every part of it explained, measured and checkable.",
    items: [
      "Grouped navigation: Product, Trust, Developers and Vision",
      "Public counters read from the server: vaults, memories, reads and sealed hours",
      "A Status page with the live health of the service and the seal job",
      "A public proof endpoint, and a checker that verifies a fingerprint, a log entry or a hand-made proof in the browser",
      "Setup guides for Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, ChatGPT and any MCP client",
      "An Import page whose drop zone hands the export straight to the vault",
      "The threat model, the API reference, the connector reference and this changelog",
      "A living page ground: engraved ciphertext under a slow drifting light",
    ],
  },
  {
    date: "2026-11-20",
    title: "One vault, five readers",
    area: "Site",
    summary: "The home page shows the same vault as you, Sigil's server, Claude, ChatGPT and Cursor each get it.",
    items: ["Lines lock into ciphertext wherever a reader was not given the folder", "The reader names are buttons, and the piece cycles on its own"],
  },
  {
    date: "2026-11-19",
    title: "Black and silver",
    area: "Site",
    summary: "The visual system: near-black ground, silver hairlines, a display serif, and self-hosted fonts only.",
    items: ["One stylesheet driven by tokens", "No third-party fonts, scripts or trackers; the content security policy allows the site itself and nothing else"],
  },
  {
    date: "2026-11-19",
    title: "The whole product, tested in a real browser",
    area: "Vault",
    summary: "End-to-end tests run every flow in Chrome against the built server.",
    items: [
      "Wallet and passkey sign-up and sign-in, with the recovery phrase",
      "Import, connecting an app, reading over MCP and revoking",
      "Seals made and verified, and the wallet deep link on a phone",
    ],
  },
  {
    date: "2026-11-19",
    title: "The vault dashboard",
    area: "Vault",
    summary: "Everything you do with your vault, in one place.",
    items: [
      "Sign in with a passkey or a wallet, and a 24-word recovery phrase",
      "Memories with titles, tags and folders, and search that runs in the browser",
      "Apps with per-folder permissions, a one-time app key and revoke",
      "The read log with Verify, import of ChatGPT and Claude exports, export and real delete",
    ],
  },
  {
    date: "2026-11-19",
    title: "The connector",
    area: "Connector",
    summary: "One MCP server for every AI app, running on the user's own machine.",
    items: [
      "Three read-only tools: list_folders, search_memories and read_memory",
      "Stdio for apps that start it, HTTP for apps that need a URL",
      "Decrypts locally and keeps nothing between requests",
    ],
  },
  {
    date: "2026-11-19",
    title: "The server, the read log and hourly seals",
    area: "Seals",
    summary: "A server that stores ciphertext only, logs every read and seals each hour.",
    items: [
      "One API router over SQLite, with deleted content overwritten on disk",
      "Every connector request written to the owner's read log with a salted fingerprint",
      "Each finished hour folded into one Merkle root that never changes afterwards",
    ],
  },
  {
    date: "2026-11-19",
    title: "The core",
    area: "Core",
    summary: "The cryptography everything else stands on, in one package shared by the browser, the server and the connector.",
    items: [
      "AES-256-GCM envelopes bound to their record, HKDF-SHA256 derivation, key slots and app keys",
      "Merkle seals and proofs",
      "Parsers for ChatGPT and Claude exports",
      "The SigilSeal contract, written and tested, not deployed",
    ],
  },
];
