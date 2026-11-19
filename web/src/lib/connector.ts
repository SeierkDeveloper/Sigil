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
