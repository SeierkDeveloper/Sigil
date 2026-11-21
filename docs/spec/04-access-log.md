# 4. The access log

Every request an app or agent makes, every suggestion, every time another vault opens a shared folder, every answer of an AI self, every protected read and the owner's answer to it, every step of a conversation between two selves, every step of a legacy plan and of a device, and every step of the AI self's identity and work, of proofs of a fact, of the emergency card, of agreements and of knowledge packs is one entry of the owner's access log.

## An entry

| Field | Meaning |
| --- | --- |
| `id` | The entry's id |
| `appId` | Who: an app id, an ask link id, the public self's id, a meet id, a share id, `vault`, `legacy`, `self` (the owner's AI self, and its test chat), a trusted person's id, an emergency card's id, an agreement's id or a knowledge pack's id |
| `kind` | What (below) |
| `memoryId` | The memory, or a step name for kinds that have no memory, or null |
| `count` | How many: memories listed, sources cited, memories written |
| `at` | When |
| `salt` | 32 random bytes in hex. Without it the leaf cannot be tied to the entry |

For an answer of an AI self (`ask`, `public`) the entry also carries a note: the question and the answer sealed to the vault's public key with the context `ask-note:<memoryId>:<appId>`. The note is not part of the leaf.

## Kinds

| Kind | Meaning |
| --- | --- |
| `folders`, `index`, `read` | An app listed folders, read the heads, read a memory |
| `propose` | An app suggested a memory |
| `shared` | Another vault opened a folder shared with it |
| `ask` | The AI self answered through an ask link or an app |
| `legacy`, `device` | A step of the legacy plan, of a device |
| `presence` | The vault was open in that hour (part 5) |
| `remember`, `forget`, `handoff`, `space` | An agent wrote, deleted, left or picked up a note, used a team space |
| `protected` | A memory in a protected folder was read after the owner's yes (memoryId null when a folder was looked through) |
| `approval` | The owner said yes (`approved-<request id>`) or no (`denied-<request id>`) to a protected read |
| `public` | The public AI self answered a visitor |
| `meet` | A step of a meet: `invited`, `accepted`, `declined`, `stopped`, `done`, `turn-<n>`, and `used-<n>` (in the writer's own log) with the number of memories its self could use |
| `sync` | A connector wrote (`wrote-<source id>`) or removed (`removed-<source id>`) memories of a live sync source in the background |
| `identity` | A step of the AI self's identity (appId `self`): `key-made`, `statement-signed`, `statement-withdrawn`, `rules-saved` (part 7) |
| `work` | A step of the AI self's work (appId `self`): `drafted-<kind>`, `approved-<kind>`, `discarded-<kind>` with kind `reply`, `plan` or `answer`; `learned`, `lesson-edited`, `lesson-deleted` |
| `disclose` | A proof of a fact was made (appId `vault`, count 1); memoryId is the hex32 hash of its signed statement (part 8) |
| `emergency` | A step of the emergency card (appId the card's id): `published`, `changed`, `reissued`, `revoked`, `opened` (part 9) |
| `agreement` | A step of an agreement (appId the agreement's id), in both parties' logs: `proposed-<id>`, `declined-<id>`, `withdrawn-<id>`, and, once both signed, the agreement's hex32 hash with count 2 (part 10) |
| `pack` | A step of a knowledge pack (appId the pack's id): `published-<version>` with the number of memories, `withdrawn`, and in a follower's log `followed-<version>`, `updated-<version>`, `unfollowed-<version>` (part 10) |
| `backup` | A bundle of the vault was made and stored (appId `vault`, or the connector's app id); memoryId is the bundle's hex32 hash, count the number of places it went to (part 11) |
| `node` | A step of restoring or moving the vault (appId `vault`, or the new node's origin for steps the old node takes for it): `restored-<hash>`, `move-signed-<move id>`, `move-cancelled-<move id>`, `bundle-sent-<move id>`, `arrived-<move id>`, `moved-<move id>`, `confirmed-<move id>` (part 11) |
| `capture` | A capture key (appId its id) sent something to the inbox (memoryId the proposal's id), or was made (`key-made`) or revoked (`key-revoked`) (part 12) |
| `session` | A step of a session with the public AI self (appId the public self's id): `booked-<booking>`, `turn-<booking>-<n>` with the sources cited and a sealed note, `ended-<booking>`, `blocked-<booking>` (part 12) |
| `injection` | The immune system caught hidden instructions (appId the app, or `immune` for the vault): where, as `quarantine`, `self`, `link`, `public`, `session`, `meet`, `legacy`, `connector` or `proposal`, with an optional `-<ref>`; count the memories held or neutralised (part 13) |

A vault that joins a team space, by making it or by accepting it, writes `space` with appId `vault` and memoryId `joined-<space id>`; a proof of membership rests on that entry. An heir who becomes a member of a shared memory writes `heir-<space id>` (part 12).

An entry that came with a bundle from another node (part 11) keeps its id, salt, leaf and hour, and carries the proof it was sealed with on that node. It is not sealed again.

## The leaf

An entry is sealed as the leaf SHA-256(0x00 || data), where data is the UTF-8 of these lines joined by a newline:

```
sigil-read-v1
<id>
<appId>
<kind>
<memoryId, or empty>
<count>
<at>
<salt>
```

Because the kind is in the leaf, a protected read cannot later be passed off as a plain read without breaking its proof. The `readEntry` vector shows the data and the leaf of one protected read.

## The privacy score

A vault may show a privacy score for each app and agent, made on the owner's device from the owner's own log, over the last 30 days. It starts at 100 and loses:

| Part | Points |
| --- | --- |
| How much it read | Up to 30: the share of the memories it may read that it read in full (`read` and `protected` entries, distinct memories), times 30, rounded |
| Folders | Up to 20: 5 for each folder it read from |
| Protected reads | Up to 25: 10 for each `protected` entry |
| How often | Up to 15: the days it was active, out of 30, times 15, rounded |
| Writes | Up to 10: 1 for every 5 suggestions, memories written or removed (`propose`, `remember`, `forget`, `sync`), rounded up |

80 and above reads as light, 50 to 79 as regular, below 50 as heavy, and an app with no entries as not active. The score must be shown with its parts. It says what was read and how often; it cannot say what an app did with it, and must not claim to. The `privacyScore` vector shows one score and its parts.
