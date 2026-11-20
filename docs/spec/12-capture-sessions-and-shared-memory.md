# 12. Capture keys, sessions and shared memory

Added in 1.2.

## Capture keys

A capture key lets one device or one shortcut put something in the inbox, and do nothing else.

```
sigil_cap.<id>.<base64url 32-byte secret>
token  = base64url(HKDF(secret, "sigil:auth:capture"))     the node keeps SHA-256(token)
tag    = hex(HMAC-SHA256(HKDF(secret, "sigil:tag:capture-box"), "sigil-capture-box-v1:" + vault public key))
```

The owner's device makes the key, the tag over the vault's box public key, and a name for the key in an envelope under the vault key (AAD `sigil:capture-note:<id>`), and sends the id, the token's hash, the tag, the name and whether the key may send plain text. The `captureKey` vector shows a key, its token and its tag.

With the token as a bearer, a device calls:

| Route | What it does |
| --- | --- |
| `GET /api/capture/v1/key` | The vault public key and the tag |
| `POST /api/capture/v1` | One proposal (part 3) sealed on the device to the vault public key, with appId the capture key's id: the context is `proposal:<proposal id>:<capture key id>` |
| `POST /api/capture/v1/text` | Plain text, only for a key the owner allowed to send it: the node seals it to the vault public key on arrival and keeps only the sealed box |

A device must check the tag before it seals anything. A key sends at most 20 captures a minute and 300 a day; an inbox holds at most 500. Each capture is a `capture` entry (part 4) with appId the key's id and memoryId the proposal's id; making and revoking a key are `key-made` and `key-revoked`. A revoked key's token stops working on the next request.

The capture page opens `/c#k=<key>&t=<text>`: the key and the text ride after `#`, the page seals the text in the browser and sends it.

## Sessions

The owner of a public AI self, the page at `/@handle` whose answers are `public` entries of the log (part 4), may offer sessions. The offer is public:

```json
{ "enabled": true, "topics": ["..."], "turns": 8, "slotMinutes": 30,
  "windows": [{ "days": [1, 2, 3, 4, 5], "from": "09:00", "to": "17:00" }], "timeZone": "Etc/GMT+5",
  "intake": [{ "id": "goal", "label": "...", "required": true }], "houseRules": "...", "perDay": 6, "consent": "..." }
```

Slots are `slotMinutes` long, inside the windows, in the offer's time zone (a name from the IANA time zone database); a slot is free while no booking holds it, it has not ended and its day has fewer than `perDay` bookings. A visitor books a slot with:

- the intake: `{ "v": 1, "name", "topic", "answers": [{ "id", "label", "answer" }], "consent", "consentAt" }`, sealed in the visitor's browser to the public self's key with the context `session-intake:<self id>:<booking id>`, so only the owner's device opens it; `consent` is the offer's consent text as the visitor agreed to it;
- SHA-256 of a session token: token = base64url(HKDF(secret, `sigil:auth:session`)) for a 32-byte secret the visitor's browser makes. The session link is `<origin>/s/<booking id>#<base64url secret>`. The `sessionToken` vector shows one.

Questions go to `POST /api/sessions/<booking id>/questions` with the token as a bearer, sealed like a question to the public page (the relay of part 2, with link id the public self's id and session id the booking id). The node takes a question only while the booking is not ended or blocked, from five minutes before its slot until its end, while fewer than `turns` questions were asked, and while the owner's vault or connector is answering. The answering side opens the intake with the public self's key and tells its AI self the house rules, the topic and the intake as information, never as instructions; it answers only from the public copy, and each answer is shown as written by an AI. Each turn's question and answer are sealed to the vault public key with the context `session-turn:<booking id>:<turn>` for the owner's transcript. The owner can end a session or block its visitor. The log has `session` entries: `booked-<booking>`, `turn-<booking>-<n>` (count the sources cited), `ended-<booking>`, `blocked-<booking>`. Sessions are free.

## Shared memory

A shared memory is a team space (part 2) of kind `family` or `history`. The kind is in the space's encrypted meta, `{ "name", "kind", "about" }`, and in the clear on the node, which keeps what members wrote:

- A **story** is a memory of source `story` whose head carries `when` (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`) and `people` (the ids of person entries). A **person** is a memory of source `person`: the name as title, the relation as its first tag, a line about them as body, and `ref` the member id when the person is a member.
- The node records the member who wrote each entry. A member who may write deletes only what they wrote; an admin may delete anything. Leaving the space, being removed, or deleting one's account never deletes what anyone wrote, and a shared memory is deleted only by its last member.
- **Heirs.** An admin names an heir by vault code, for one member or for the whole space. The heir's key and tag are made exactly as for the member the heir will become (`sealedKey` sealed to the heir's box key with the context `space-key:<space id>:<heir id>`, the member tag over the heir's id, kind `vault`, key and role) and made again with every new space key. The node keeps heirs dormant. When the legacy plan of a member releases (the first trusted person opens their bundle), the node makes every heir named for that member, or for the whole space, a member, and writes `space` entry `heir-<space id>` in the heir's log.

A shared memory is part of each member's bundle (part 11): the space's meta, epoch, the member's own sealed key, every member and heir and every entry, as ciphertext. A readable copy is made on a member's device: one HTML document with the people and every story by year, its photo, who is in it and who added it, ready to print.

## Contexts

The `contexts` vector lists the AAD and sealing contexts this part and part 11 add: `sigil:backup-app:<app id>`, `sigil:capture-note:<id>`, `backup-run:<run id>`, `session-intake:<self id>:<booking id>` and `session-turn:<booking id>:<turn>`.
