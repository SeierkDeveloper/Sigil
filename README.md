# Sigil

**Your AI self, owned by you, forever.**

Sigil is a memory vault that is encrypted on your own device. Claude, ChatGPT, Cursor and other AI apps read it through one connector, only the folders you allow each of them to see, and every read is written to a log that is sealed every hour.

## What is in this repository

| Folder | What it is |
| --- | --- |
| `packages/core` | Client-side cryptography (AES-256-GCM, HKDF, key slots, app keys), Merkle seals, search, and the ChatGPT and Claude export parsers. Used by the browser, the server and the connector. |
| `web` | The site and the server: Next.js App Router pages, the vault dashboard, and the API (`web/src/server`) backed by SQLite. |
| `connector` | `sigil-connector`, the MCP server people run on their own machine. Stdio for Claude Desktop and Cursor, HTTP for apps that need a URL. |
| `contracts` | `SigilSeal.sol`, which records hourly seal roots on chain. Written and tested; not deployed. |
| `e2e` | Playwright tests that run the whole product in Chrome against the built server. |
| `docs` | The design brief and screenshots. |

## Run it

Needs Node.js 22.13 or newer (for the built-in SQLite) and, for the contract tests, Foundry.

```sh
npm install
npm run build        # connector + site
npm start            # http://localhost:3000, data in web/.data/sigil.db
```

For development: `npm run dev`.

## Tests

```sh
npm run test:unit       # core, server and connector (vitest)
npm run test:contracts  # forge test in contracts/
npm run test:e2e        # builds, starts the server on :3210, runs Playwright in Chrome
```

`npm test` runs all three.

## Settings

See `web/.env.example`. The important switches:

- `SIGIL_SEALS` (default `on`): seal the read log locally at the end of every hour.
- `SIGIL_ANCHOR` (default `off`): publish seal roots to the SigilSeal contract. Needs `SIGIL_ANCHOR_RPC_URL`, `SIGIL_SEAL_CONTRACT` and `SIGIL_SEALER_KEY`. While it is off, the site labels every seal "Local".
- `NEXT_PUBLIC_SITE_URL`: the public address, used in connector snippets. Set at build time.
- `SIGIL_ORIGIN`: the origin trusted for passkeys and same-origin checks in production.

Links (GitHub, X), the logo file and whether the connector is on npm are set in `web/src/lib/site.ts`.

## How the encryption works

The browser makes a random vault key at sign-up and wraps it once per sign-in method: with a key from the passkey's PRF extension, from a wallet signature over a fixed message, and from a 24-word recovery phrase. Each folder has its own key, wrapped by the vault key; memories are encrypted with their folder's key, and every ciphertext is bound to its record with AES-GCM associated data. The server stores envelopes, ids, sizes, times and hashes of sign-in tokens. The full model is on the site under Docs, Encryption model.

## How the connector works

An app key (`sigil_app.<app id>.<secret>`) is made in the browser for each connected app and shown once. From its secret the connector derives a bearer token (the server keeps only its hash) and a key that unwraps the folder keys granted to that app. The connector fetches ciphertext, decrypts on the user's machine, and offers three read-only MCP tools: `list_folders`, `search_memories`, `read_memory`. Every request is logged; revoking deletes the app's token hash and wrapped keys, so the next request fails.

## Licence

MIT.
