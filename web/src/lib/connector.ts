// The connector configuration snippets, shared by the docs and the vault's Apps page.

import { site } from "./site";

export type ClientKind = "claude-desktop" | "cursor" | "chatgpt" | "other";

export const SOURCE_PATH = "/path/to/Sigil/connector/dist/index.js";

export function launchCommand(): { command: string; args: string[] } {
  return site.connectorPublished ? { command: "npx", args: ["-y", site.connectorPackage] } : { command: "node", args: [SOURCE_PATH] };
}

export function mcpConfig(appKey: string, url = site.url): string {
  const { command, args } = launchCommand();
  return JSON.stringify({ mcpServers: { sigil: { command, args, env: { SIGIL_APP_KEY: appKey, SIGIL_URL: url } } } }, null, 2);
}

export function shellCommand(appKey: string, url = site.url, http = false): string {
  const { command, args } = launchCommand();
  const run = [command, ...args, ...(http ? ["--http", "--port", "8787"] : [])].join(" ");
  return `SIGIL_APP_KEY=${appKey} \\\nSIGIL_URL=${url} \\\n${http ? "SIGIL_HTTP_TOKEN=<a long random string> \\\n" : ""}${run}`;
}

export const buildFromSource = `git clone ${site.githubUrl}.git
cd Sigil
npm install
npm run build -w ${site.connectorPackage}`;

export const configLocations: Record<Exclude<ClientKind, "chatgpt" | "other">, { title: string; where: string[] }> = {
  "claude-desktop": {
    title: "Claude Desktop",
    where: [
      "Open Claude Desktop, then Settings, Developer, Edit Config. Or open the file directly:",
      "macOS: ~/Library/Application Support/Claude/claude_desktop_config.json",
      "Windows: %APPDATA%\\Claude\\claude_desktop_config.json",
    ],
  },
  cursor: {
    title: "Cursor",
    where: ["Global, for every project: ~/.cursor/mcp.json", "One project only: .cursor/mcp.json in the project folder"],
  },
};

/** VS Code keeps MCP servers under "servers", with a type, in .vscode/mcp.json. */
export function vscodeConfig(appKey: string, url = site.url): string {
  const { command, args } = launchCommand();
  return JSON.stringify({ servers: { sigil: { type: "stdio", command, args, env: { SIGIL_APP_KEY: appKey, SIGIL_URL: url } } } }, null, 2);
}

/** One command that adds the connector to Claude Code for every project of this user. */
export function claudeCodeCommand(appKey: string, url = site.url): string {
  const { command, args } = launchCommand();
  return `claude mcp add sigil --scope user \\\n  --env SIGIL_APP_KEY=${appKey} \\\n  --env SIGIL_URL=${url} \\\n  -- ${[command, ...args].join(" ")}`;
}

export const EXAMPLE_KEY = "sigil_app.<app id>.<secret>";

/** The connector keeping live sync sources in sync while the vault is closed. */
export function watchCommand(appKey: string, url = site.url): string {
  const { command, args } = launchCommand();
  return `SIGIL_APP_KEY=${appKey} \\\nSIGIL_URL=${url} \\\n${[command, ...args, "--watch"].join(" ")}`;
}
