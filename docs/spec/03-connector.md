# 3. The connector

A connector holds one app key and runs where the owner chooses (their own machine for an MCP client, a web page for Sign in with Sigil). It fetches ciphertext with the app's bearer token, unwraps the folder keys granted to it with the app's wrap key, and decrypts, searches and seals on its own side. A server only ever hands out ciphertext for what the owner granted.

## MCP tools

| Tool | What it does | Permission | Logged as |
| --- | --- | --- | --- |
| `get_profile` | The Self card | The Self card folder is granted | `index`, then `read` |
| `list_folders` | Granted folders and their counts; protected ones are marked | Any grant | `folders` |
| `search_memories` | Search by meaning and words over titles, tags and first lines, on the connector's side | Any grant | `index` (and `protected` when a protected folder is looked through) |
| `read_memory` | One memory in full | Its folder is granted | `read`, or `protected` |
| `propose_memory` | A suggestion sealed to the vault's public key, after checking its tag | The owner turned suggestions on for the app | `propose` |
| `ask_self` | The owner's AI self answers, with the owner's model key, from folders both granted and in its rules | The owner allowed the app to answer as the AI self | `ask`, with the question and answer sealed to the vault |

| `get_thresholds` | The owner's thresholds for mail, invites and negotiation, in plain lines | The owner lets the app act (under Limits) | nothing |
| `check_action` | Before mail or an invite: `allowed`, `needs-approval` (sealed to the vault and waiting in Work) or `refused`, decided on the connector's side against the thresholds; with an `id`, how the owner answered | The owner lets the app act | `work` (`act-<area>-<state>`) |
| `report_action` | After acting: a receipt signed with the app's receipt key under the self key's delegation, sealed to the vault | A step that was allowed or approved | `identity` (`receipt`) and `work` |
| `negotiate` | One step of a negotiation within the owner's ranges: `accept`, `counter` or `ask` (waiting in Work) | The owner lets the app act | `work` |

An agent key (an app with an agent record) adds `remember` (logged `remember`), `recall` (reads as above), `forget` (`forget`), `leave_handoff` and `pick_up_handoffs` (`handoff`). Each is a switch the owner sets; the server refuses a call whose switch is off. No tool changes or deletes a memory unless the owner gave an agent write access to that folder.

## HTTP routes for an app key

All under `/api/connector/v1/`, with `Authorization: Bearer <token>`. They take no cookie, so any origin may call them.

| Route | Purpose |
| --- | --- |
| `GET folders`, `GET index`, `POST read` | Granted folders, the heads of their memories, whole memories |
| `GET inbox`, `POST proposals` | The vault public key and its tag; a sealed suggestion |
| `GET self`, `GET self/pending`, `POST self/questions/<id>/answer`, `POST self/asked` | The AI self's config wrapped for the app, ask link questions, answers, and the sealed note of an `ask_self` answer |
| `GET public`, `GET public/pending`, `POST public/questions/<id>/answer` | The public AI self, when the owner picked this app to answer it |
| `GET agent`, `POST remember`, `POST forget`, `GET handoffs`, `POST handoffs`, `POST handoffs/picked`, `GET spaces`, `POST spaces/<id>/memories`, `POST spaces/<id>/forget` | An agent's own memory, notes and team spaces |
| `GET acting`, `POST acting`, `GET acting/<id>`, `POST acting/<id>/receipt` | The thresholds wrapped for the app and when the steps taken alone in the last two days happened (the app counts them from midnight in the owner's time zone); a step (allowed, waiting or refused, sealed to the vault); the owner's answer under the app's key; the receipt of a step carried out |
| `GET sync`, `PUT sync/<id>`, `POST sync/<id>/memories`, `POST sync/<id>/delete` | Live sync sources the owner lets this app sync in the background: its copy of each, and writes only into the source's folder |

A revoked key gets 401 on its next request.

## Protected folders

A server must not hand a memory in a protected folder to an app, an agent, an ask link or the public AI self without a fresh yes from the owner for that read.

1. `GET index` leaves protected folders out. `GET index?protected=<folder id>` asks to look through one.
2. `POST read` returns memories in protected folders in a `held` list (`folderId`, `memoryIds`, `requestId`, `state`) instead of in `memories`.
3. Either way, a request waits for the owner: requester, folder, scope (`index` or `read`), memory ids. Asking again for the same read does not make a second request. A request not answered within 30 minutes lapses.
4. The owner says yes or no in the vault (logged as `approval`). A yes lasts 10 minutes and covers the one read it names.
5. The same call again within those minutes gets the memories, the yes is used up, and each memory read is logged as `protected` instead of `read`.

On the owner's own device, where every key is at hand, the vault applies the same gate to the AI self (answering a link, another self, or the owner's test chat): it asks with requester kinds `link`, `meet` or `self`, reads a protected folder only with an approval that covers the memories, and marks the approval used, which logs each memory read as `protected`. A protected folder can never be made public.

## Redaction

A folder may name redaction rules. Before anything from the folder leaves the vault (to an app through a connector, to a model, to a public page or to another self) the device masks:

| Rule | Shape | Mask |
| --- | --- | --- |
| `email` | An address with an @ and a domain | `[email hidden]` |
| `iban` | Two letters, two digits and 10 to 30 letters and digits that pass the mod 97 check | `[IBAN hidden]` |
| `card` | 13 to 19 digits, spaces or dashes allowed, that pass the Luhn check | `[card number hidden]` |
| `national_id` | Three, two and four digits with dashes; six or eight digits, a dash or plus, four digits; two letters, six digits and a letter | `[ID number hidden]` |
| `passport` | Six to nine letters and digits after the word passport | `[passport number hidden]` |
| `phone` | 7 to 15 digits with separators, starting with +, ( or 0, or written 3-3-4; not a date | `[phone number hidden]` |
| `account` | A number after the word account, and any run of 8 to 18 digits left | `[account number hidden]` |

Rules run in the order email, iban, card, national_id, passport, phone, account. Title, tags, first lines and text are all masked; the vault keeps the text as written. Redaction matches shapes: a number written in an unusual way can slip through, and a number that only looks like one can be masked. The `redaction` vector shows every rule on one text, and one rule alone.

## The public copy

The public AI self answers only from a public copy of the folders the owner made public: live memories (no Self card, no brief), each masked with its folder's rules, as `{ id, title, body, tags, editedAt }`, the title at most 300 characters and the text at most 20,000, newest first. The owner's device publishes it in the clear on purpose and publishes it again when its hash changes: SHA-256 of the JSON list of `[id, title, body, tags, editedAt]`, in hex. The `publicCopy` vector shows one hash.
