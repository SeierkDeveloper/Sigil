# sigil-connector

Lets Claude Desktop, Claude Code, Cursor, ChatGPT and other MCP apps read the parts of your Sigil vault you choose, search them by meaning, suggest memories to your inbox, and ask your AI self, when you allow it. With an agent key, an agent also gets a memory of its own. It runs on your own machine: it decrypts, searches, seals and calls your model there.

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

- `get_profile`: the Self card, and the lessons of a model of you when the owner shares them, when this app may read the Self card folder.
- `list_folders`: the folders this app may read.
- `search_memories`: search by meaning and by the words in titles, tags and first lines, locally. Arguments: `query`, optional `folder` and `limit`.
- `read_memory`: the full text of one memory by `id`.
- `propose_memory`: suggest a memory to the vault's inbox (`title`, `body`, optional `tags` and `folder`). Sealed here for the vault; it becomes a memory only when the owner approves it. Needs "May suggest memories" on for this app.
- `ask_self`: ask the owner's AI self a `question`. It answers as the owner, only from the folders the owner's rules allow that this app may also read, with the owner's own model key, called from this machine. Needs "May answer as your AI self" on for this app, under AI self in the vault.

No tool above changes or deletes a memory, and every request shows up in the vault's read log.

## Agent keys

When the key belongs to an agent (made under Agents in the vault), the connector checks that at start and adds seven tools. The server enforces the switch the owner set for each, and which folders the agent may write.

- `remember`: write a memory (`title`, `body`, optional `tags` and `folder`) to the agent's own folder, or to a folder or team space it may write. Encrypted here.
- `recall`: search what it may read, its team spaces included, by meaning and words here, and return the best matches in full (`query`, optional `limit`).
- `forget`: delete memories by `ids`, for good, only where it may write. Off unless the owner allows it.
- `leave_handoff`: an encrypted note (`text`) for its next session, or (`space`, optional `to`) for the agents in a team space.
- `pick_up_handoffs`: the notes waiting for it, marked as picked up.
- `pin_memory`: pins the agent's own folder exactly as it is now and returns a pointer (node, vault, folder, version, fingerprint) to keep, for example in a checkpoint.
- `restore_memory`: brings the folder back exactly as it was at a pinned version (`pointer`, or just its `version`), checked against its fingerprint on this machine.

Claude Code, for every project:

```sh
claude mcp add sigil --scope user \
  --env SIGIL_APP_KEY=sigil_app.<app id>.<secret> \
  --env SIGIL_URL=<address of your Sigil site> \
  -- node /path/to/Sigil/connector/dist/index.js
```

Cursor (`~/.cursor/mcp.json`), Claude Desktop and VS Code (`.vscode/mcp.json`, under `servers` with `"type": "stdio"`) take the JSON above. The handoff notes are signed with the name the MCP client gives itself.

## Answering ask links

```sh
SIGIL_APP_KEY=... SIGIL_URL=... node dist/index.js --self
```

Answers the ask links the owner gave this app, and the owner's public AI self when the owner picked this app for it (booked sessions included, with their house rules and intake), while it runs, so they work with the vault closed. Questions arrive as relay boxes only this machine and the asker can open; the answer goes back the same way, and the question and answer go to the owner's read log sealed to the vault's public key. The links show as online while it runs.

## Live sync and Obsidian

```sh
SIGIL_APP_KEY=... SIGIL_URL=... node dist/index.js --watch                                       # live sync sources given to this app
SIGIL_APP_KEY=... SIGIL_URL=... node dist/index.js --watch "/path/to/Obsidian vault" [--folder Obsidian]
```

Without a folder, it keeps the live sync sources (Gmail, Google Calendar, Google Drive, Slack) the owner lets this app sync in the background: every 5 minutes (`SIGIL_SYNC_MINUTES`) it opens each source with this app's key, asks the service for what changed, encrypts every item here with the folder key and writes it to the source's folder only. A client type that asks for a secret at the token step can be given `SIGIL_GOOGLE_CLIENT_SECRET` or `SIGIL_SLACK_CLIENT_SECRET` on this machine; it is never sent to Sigil.

With a folder, it also watches it and suggests new and changed notes to the owner's inbox, sealed here, with the note's path, so the vault offers to update the memory imported from the same note. Use an app key that may suggest memories and read the folder the vault was imported into: on the first run, notes the vault already holds unchanged are not suggested again. Up to 8 notes go in one pass and the rest follow a minute later. What was sent is remembered as hashes in `~/.sigil-connector` (or `SIGIL_STATE_DIR`).

## Backups

When the owner lets this app back the vault up (under Storage in the vault), `--watch` also stores a copy of the vault on the owner's schedule: it asks the node for the vault's bundle (ciphertext), writes it from this machine to the owner's own storage (an S3-compatible bucket, IPFS or Arweave) with the owner's tokens, which only this app's key opens, and logs it with a record of where it went sealed to the vault's key. This app never holds the vault key, so its bundles are not signed; the owner's device checks every part when it restores one.

## After a move

When the vault moves to another node, the old node answers this app with the new address. Set `SIGIL_URL` to it; the same app key keeps working there.

## Search by meaning

A small sentence model (`Xenova/all-MiniLM-L6-v2` by default) runs here on WebAssembly. Its files are fetched once from the public model hub into `SIGIL_MODEL_DIR` (`.data/models` in the repository, `~/.sigil/models` elsewhere); vectors stay in memory and are never sent anywhere. `SIGIL_MODEL_FETCH=off` uses only files already on disk, and `SIGIL_SEMANTIC=off` searches by words only.

## Protected folders

Folders the owner protected are left out of searches; the tool says which. Naming one in a search, or reading a memory in one, asks the owner in their inbox; the same call works once they say yes, within 10 minutes, for that one read. Each folder's redaction rules (card, IBAN, account, ID, passport and phone numbers, email addresses) are applied here before any text is handed to the app.

## HTTP mode

For apps that connect to a URL instead of starting a program:

```sh
SIGIL_APP_KEY=... SIGIL_URL=... SIGIL_HTTP_TOKEN=<long random string> node dist/index.js --http --port 8787
```

It serves `http://127.0.0.1:8787/mcp/<token>`. Anyone with the full address can read what the app key can read, so keep it private and revoke the key in your vault when you are done.
