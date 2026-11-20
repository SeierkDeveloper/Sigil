# 4. The access log

Every request an app or agent makes, every suggestion, every time another vault opens a shared folder, every answer of an AI self, every protected read and the owner's answer to it, every step of a conversation between two selves, and every step of a legacy plan and of a device is one entry of the owner's access log.

## An entry

| Field | Meaning |
| --- | --- |
| `id` | The entry's id |
| `appId` | Who: an app id, an ask link id, the public self's id, a meet id, a share id, `vault`, `legacy`, `self` (the owner's test chat) or a trusted person's id |
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
