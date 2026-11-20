# @sigil/sdk: Sign in with Sigil

Let people give your web app read access to chosen folders of their Sigil vault. What they allow is decrypted in their browser, on your page; your server never needs to see it.

```js
import { requestAccess, SigilClient } from "@sigil/sdk";

// From a click: opens a window from their vault, where they choose folders and allow.
const access = await requestAccess({ vault: "https://their-sigil.example", appName: "My notes app" });

const sigil = new SigilClient(access);
await sigil.folders();                 // the folders they gave you
await sigil.search("trip to Rome");    // searched in the browser; the query is never sent
await sigil.read([id]);                // whole memories, each read logged for them
await sigil.profile();                 // their Self card, if they gave you its folder
```

## How it works

1. `requestAccess` opens `/vault/authorize` on their Sigil site with your app's name, your page's origin and a random state.
2. They unlock their vault in that window and choose what you may read (and, if you pass `suggest: true`, whether you may suggest memories to their inbox).
3. Their vault makes an app key for your app alone and posts it back to your page with `postMessage`, to your exact origin. A page on any other origin never receives it.
4. `SigilClient` uses the key the same way the MCP connector does: it fetches ciphertext for the granted folders and decrypts it here.

They can change your app's folders or revoke it at any time under Apps in their vault, and every read your app makes is in their read log, sealed hourly.

## Keeping the key

The app key reads what the person allowed. Keep it the way you keep a password: in memory or session storage for a session, or encrypted at rest if you store it. When they revoke your app, the next call fails with status 401.

## Errors

`requestAccess` rejects with a `SigilAccessError` whose `code` is `denied`, `closed`, `blocked` (pop-up blocked; call it from a click), `timeout` or `invalid`.

## Build

```sh
npm run build -w @sigil/sdk   # dist/sigil.js, one ES module
```

A complete example is in `examples/hello-sigil`.
