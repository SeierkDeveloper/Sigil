# 1. Memories and folders

## Folders

A vault holds folders; every memory is in exactly one folder. A folder is stored as:

| Field | Value |
| --- | --- |
| `id` | The folder id |
| `meta` | An envelope (part 2) under the folder key, AAD `sigil:folder-meta:<folder id>`, holding the folder meta |
| `wrappedKey` | The folder key (32 random bytes) in an envelope under the vault key, AAD `sigil:folder-key:<folder id>` |

The folder meta is a JSON object:

| Key | Meaning |
| --- | --- |
| `name` | The folder's name, at most 120 characters |
| `kind` | Optional. `profile` for the folder that holds the Self card, `agent` for an agent's own folder |
| `protect` | Optional. `health`, `money`, `legal` or `other`: the folder is protected (see part 3) |
| `redact` | Optional. A list of redaction rules (part 3), in the order `card`, `iban`, `account`, `national_id`, `passport`, `phone`, `email` |

Unknown values of `protect` and `redact` must be dropped when the meta is read. Renaming a folder must keep `kind`, `protect` and `redact`. Because the kind of a protected folder is in the encrypted meta, a server learns only that a folder is protected (it needs that flag to hold the folder back), never whether it holds health, money or legal records. The `folder` vector holds a meta with protection and redaction, sealed under the folder key of `input`.

## Memories

A memory is stored as two envelopes under its folder's key:

| Part | AAD | JSON inside |
| --- | --- | --- |
| `head` | `sigil:memory-head:<memory id>` | `title`, `tags`, `source`, `snippet`, `createdAt`, `editedAt`, and `expiresAt` when set |
| `body` | `sigil:memory-body:<memory id>` | `body` (the text), and `image` when set |

- `title`: at most 300 characters; an empty title is stored as `Untitled`.
- `tags`: lowercase, spaces as `-`, each at most 48 characters, at most 32, no repeats.
- `snippet`: the first 240 characters of the text with Markdown headings and fences removed and white space collapsed, so a connector can search without reading every body.
- `source`: `{ "kind": <source kind>, "ref": <optional string> }`. Kinds: `note`, `chatgpt`, `claude`, `app`, `web`, `profile`, `brief`, `obsidian`, `apple-notes`, `gmail`, `calendar`, `github`, `notion`, `capture`, `agent`, `slack`, `drive`, `meeting`. `ref` names the thing at its source (a mail thread, an event UID, a file id), so the same thing is never kept twice.
- `expiresAt`: after it, the memory leaves every app's view; a server may delete it for real after a grace period it is told in the clear.
- `image`: `{ "type": "image/jpeg" | "image/png" | "image/webp", "data": <base64> }`, at most 2,000,000 characters.

The `memory` vector is a memory stored under the folder key of `input`.

## Live sync

A memory written by live sync has the `source` of its service (`gmail`, `calendar`, `drive`, `slack`) and a `ref`:

| Source | `ref` |
| --- | --- |
| `gmail` | The thread id in decimal (the Gmail API gives it in hex; Google Takeout files carry the decimal form as `X-GM-THRID`) |
| `calendar` | The event's iCalendar UID, and for a moved instance of a repeating event `#` and the original start in the form `20260115T093000Z` |
| `drive` | The file id |
| `slack` | `<channel id>:<YYYY-MM-DD>`: one memory per channel and day |

When no memory with the same source and ref exists, its id is the first 22 characters of base64url(HMAC-SHA256(k, kind + "\n" + ref)), with k = HKDF(folder key, "sigil:sync-id"). Every device that holds the folder key makes the same id, so two devices syncing at once write one memory. The `syncId` vector shows one.

## Meeting memories

A memory made from a meeting transcript has source kind `meeting`, its `ref` the first 32 hex characters of the SHA-256 of the file, and a body in Markdown with the sections `## Who was there`, `## In short` (when there is a summary), `## Decisions`, `## Promises` and `## Transcript`.
