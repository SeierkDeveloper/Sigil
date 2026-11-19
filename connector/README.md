# sigil-connector

Lets Claude Desktop, Cursor, ChatGPT and other MCP apps read the parts of your Sigil vault you choose. It runs on your own machine and decrypts there.

## Setup

1. In your Sigil vault, open Apps, choose Connect an app, pick the folders it may read, and copy the app key.
2. Add the connector to your MCP app:

```json
{
  "mcpServers": {
    "sigil": {
      "command": "node",
      "args": ["/path/to/Sigil/connector/dist/index.js"],
      "env": {
        "SIGIL_APP_KEY": "sigil_app.<app id>.<secret>",
        "SIGIL_URL": "<address of your Sigil site>"
      }
    }
  }
}
```

Build `dist/index.js` with `npm run build -w sigil-connector` from the repository root.

## Tools

- `list_folders`: the folders this app may read.
- `search_memories`: search titles, tags and first lines, locally. Arguments: `query`, optional `folder` and `limit`.
- `read_memory`: the full text of one memory by `id`.

All tools are read only, and every request shows up in the vault's read log.

## HTTP mode

For apps that connect to a URL instead of starting a program:

```sh
SIGIL_APP_KEY=... SIGIL_URL=... SIGIL_HTTP_TOKEN=<long random string> node dist/index.js --http --port 8787
```

It serves `http://127.0.0.1:8787/mcp/<token>`. Anyone with the full address can read what the app key can read, so keep it private and revoke the key in your vault when you are done.
