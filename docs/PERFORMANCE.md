# Performance with a big vault

Sigil does its work where the plaintext is: the owner's browser decrypts, searches and builds prompts. A vault with years of mail and chats is a big job for a browser tab. This page says what was measured, what changed, and the budget each step is held to.

## How it is measured

- `npm run seed` writes a vault to a database file a node can open, and prints its recovery phrase (sign in with it to look around). `npm run perf` makes the same vault in memory and times each step against its budget. Neither runs in `npm test`: together they take several minutes of one CPU.
- The vault: 100,000 memories spread over five years in 40 folders, 12 connected apps, 200,000 read-log entries over two years. Every memory is made and encrypted by the same code as a real vault (`web/perf/seed.ts`). `SIGIL_PERF_MEMORIES` sets another size; budgets scale with it.
- The steps run in Node 25 on a laptop (one worker, `nice`), through the same code the browser runs; requests go into the API router in-process, so network time is not included. WebCrypto in Node and in Chrome are close for these operations; a phone is slower (see below).
- The timings of the last run are written to `web/perf/last-run.json` (not committed).

## Results

"Before" is the code of round seven. Its numbers at 100,000 memories came from the first full run, made after only the first, cheap fixes (marked); the 10,000 column is the round seven code as it was.

| Step | Before, 10,000 | First run, 100,000 | After, 100,000 | Budget, 100,000 |
| --- | --- | --- | --- | --- |
| The vault's answer at unlock (`GET /api/vault`, 170 MB) | 269 ms | 3.9 s | 4.4 s | 5 s |
| Unlock: every memory decrypted (`loadVault`) | 3.0 s | 21.5 s (batched already) | 23.4 s | 25 s |
| Search by words, first search (builds the word index) | 201 ms | 2.3 s | 5.3 s | 6 s |
| Search by words, each keystroke after that | 214 ms | 1.9 s | 201 ms | 250 ms |
| Search by meaning (words plus 100,000 vectors) | 206 ms | 2.5 s | 860 ms | 1 s |
| Timeline layout (grouping by month and day) | 11 ms | 109 ms | 98 ms | 500 ms |
| Timeline rows drawn | every memory | every memory | 300, more on request | 300 |
| A live sync pass into the vault | 15 ms | 133 ms | 145 ms | 2 s |
| Sealing one hour of 5,000 reads | | 220 ms | 99 ms | 1 s |
| Catching up two years of unsealed hours | 2.4 s | 10.2 s | 10.9 s | once, at start |
| One page of the read log | 2 ms | 2 ms | 5 ms | 200 ms |
| One proof | 0 ms | 65 ms | 49 ms | 50 ms |
| The whole vault as a bundle (164 MB) | 7.3 s | 583 s | 66.5 s | 75 s |

What changed:

- **Bundles.** Each log entry's proof rebuilt its hour's whole Merkle tree, so an hour with thousands of reads cost thousands of trees: 583 seconds for the whole vault. Each sealed hour's tree is now built once (`merkleTree`), the bundle's message is made once for its hash and its signature, and the file is compressed at level 1 (ciphertext barely compresses at any level). 583 s to 66.5 s.
- **Search.** Every keystroke split every memory's text into words again. From 2,000 memories on, search builds a word index once per change of the memories and answers each keystroke from it, with the same hits and scores (a test compares them). The Memories screen keeps the same list of items between keystrokes, so the index is reused. 1.9 s to 201 ms a keystroke; the first search pays for the index.
- **Timeline.** It drew a row for every memory; it now draws the newest 300 and adds 300 with "Show earlier memories". Its dates are formatted with one formatter instead of one per row.
- **Unlock.** Memories were decrypted one after another; they are now opened in batches of 256 that run side by side, so the browser's crypto can overlap them. The first 100,000 run already includes this; in Node the gain was small, and it was not measured in a browser.
- **Linear parsing.** The backtracking patterns removed for security (see SECURITY-REVIEW.md) also removed multi-second stalls on long mail.

## Budgets

The budgets above are for a laptop at 100,000 memories. They scale with the number of memories (the check divides by 100,000). A phone is held to four times the laptop budget. That factor is an assumption, not a measurement: check it on a real phone (docs/GO-LIVE-CHECKS.md) before relying on it. At 10,000 memories the laptop unlock was 3 seconds, so a phone would be held to 12.

## What is still slow, and the next step

Unlocking a vault of 100,000 memories takes over 20 seconds, and the server's answer is 170 MB. Both grow with the vault, because the vault page fetches and decrypts every memory body when it opens. The next step is to load the heads first (titles, tags, first lines: enough to draw every list), show the vault, and fetch and decrypt the bodies in the background in pages, with search by words working on the first lines until the bodies are in. That changes what many screens may assume about a memory's body, so it was left for a round of its own rather than done here in a hurry. Until then, the budget for unlock at 100,000 memories is 25 seconds on a laptop, and the vault shows "Decrypting your vault" while it works.

Searching by words the first time also builds the index (5 s at 100,000); doing that in a worker after unlock, before the first search, is part of the same step.
