# sigil-connector

Lets Claude Desktop, Cursor, ChatGPT and other MCP apps read the parts of your Sigil vault you choose, search them by meaning, and suggest memories to your inbox when you allow it. It runs on your own machine: it decrypts, searches and seals there.

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

- `get_profile`: the Self card, when this app may read its folder.
- `list_folders`: the folders this app may read.
- `search_memories`: search by meaning and by the words in titles, tags and first lines, locally. Arguments: `query`, optional `folder` and `limit`.
- `read_memory`: the full text of one memory by `id`.
- `propose_memory`: suggest a memory to the vault's inbox (`title`, `body`, optional `tags` and `folder`). Sealed here for the vault; it becomes a memory only when the owner approves it. Needs "May suggest memories" on for this app.

No tool changes or deletes a memory, and every request shows up in the vault's read log.

## Search by meaning

A small sentence model (`Xenova/all-MiniLM-L6-v2` by default) runs here on WebAssembly. Its files are fetched once from the public model hub into `SIGIL_MODEL_DIR` (`.data/models` in the repository, `~/.sigil/models` elsewhere); vectors stay in memory and are never sent anywhere. `SIGIL_MODEL_FETCH=off` uses only files already on disk, and `SIGIL_SEMANTIC=off` searches by words only.

## HTTP mode

For apps that connect to a URL instead of starting a program:

```sh
SIGIL_APP_KEY=... SIGIL_URL=... SIGIL_HTTP_TOKEN=<long random string> node dist/index.js --http --port 8787
```

It serves `http://127.0.0.1:8787/mcp/<token>`. Anyone with the full address can read what the app key can read, so keep it private and revoke the key in your vault when you are done.
