# Go-live checks

Everything below was built and tested against stand-ins: recorded provider answers, a storage service played by the tests, a tiny speech model kept in the repository, a test model for the immune system. None of it has been run against the real services. These are the checks to run, by hand, with your own accounts, before people rely on each part. Each says what to do and what you should see.

The scripts are in `scripts/live-checks/`. They read what they need from the environment, or ask for it on the terminal without showing what you type. They print secrets only as their length. They never run in `npm test` or in CI (they refuse to when `CI` is set). Run them from the repository root after `npm install` and `npm run build`.

```
node scripts/live-checks/run.mjs <health|oauth-google|oauth-slack|storage|connector|speech-model|capture>
sh scripts/live-checks/docker.sh
sh scripts/live-checks/contracts.sh
```

Use test accounts and a test workspace throughout. Nothing here needs a real person's data.

## 1. The node itself

**Script:** `run.mjs health` with `SIGIL_URL=https://<your node>`.

1. Deploy the node (railway.toml at the repository root; the variables are listed in `web/.env.example`).
2. Run the script.

Expected:
- `PASS health` and `PASS origin matches the address`. A FAIL on origin means `SIGIL_ORIGIN` is unset or wrong: set it to the public https address and redeploy (it is also a build argument).
- `PASS content security policy`, `PASS HSTS`, `PASS nosniff`.
- `PASS seal job`, mode `local` until anchoring is on.
- Every page answers 200.
- In the node's log at start: no line about SIGIL_ORIGIN and none about the data folder. If the data folder line appears on Railway, set `RAILWAY_RUN_UID=0`.

## 2. The container image

**Script:** `sh scripts/live-checks/docker.sh` (needs Docker; uses port 8099 and a throwaway volume, removed afterwards).

Expected: `PASS health` with the node's JSON, `PASS /data is writable`, and the image size (a few hundred MB). The build runs `npm ci` and `next build`; it takes several minutes the first time.

## 3. Google sign-in for live sync (Gmail, Calendar, Drive)

**Script:** `run.mjs oauth-google` with `SIGIL_GOOGLE_CLIENT_ID` (and, for a Desktop client only, `SIGIL_GOOGLE_CLIENT_SECRET`).

Google's documentation says browser apps should use the authorization code flow with PKCE, and that Desktop clients are public clients whose secret is not confidential. Whether its token endpoint accepts a Web application client's code exchange without the client secret was not confirmed from the documentation, so this check settles it.

Steps:
1. In Google Cloud, make a project, enable the Gmail, Calendar and Drive APIs, configure the OAuth consent screen (testing mode is fine, add your test account) and add the three read-only scopes.
2. Make an OAuth client of type **Web application** with the redirect URI `https://<your node>/vault/connect` and the JavaScript origin `https://<your node>`. Set `SIGIL_GOOGLE_CLIENT_ID` on the node.
3. In the vault, Live sync, connect Gmail. Expected: a Google window, then "Gmail is connected" and memories in the Mail folder.
4. If step 3 fails with a message about a missing client secret: make a second OAuth client of type **Desktop app**, run the script with that client's id and secret on your own computer, and expect `PASS code exchange with PKCE and the client secret`, a refresh token, and `PASS one read-only call`. Then use the computer sign-in (step 6).
5. The script also prints what Google's token endpoint answers a browser's preflight; an `allow-origin` other than `none` means the browser path can work.
6. Computer sign-in: in the vault, Live sync, tick "Sign in on my computer instead", pick the app whose key the connector uses, press Prepare. Run the command shown, on your computer, with `SIGIL_APP_KEY`, `SIGIL_GOOGLE_CLIENT_ID` and `SIGIL_GOOGLE_CLIENT_SECRET` (the Desktop client's) set there. Expected: a browser window, then "Signed in to ..." in the terminal; then `sigil-connector --watch` writes the first memories.

## 4. Slack sign-in for live sync

**Script:** `run.mjs oauth-slack` with `SIGIL_SLACK_CLIENT_ID`, optionally `SIGIL_SLACK_CLIENT_SECRET`, and `SIGIL_CHECK_PORT` (8790 by default).

Slack's documentation lists `code_verifier` for PKCE on `oauth.v2.access` and an error for apps not allowed to use PKCE, keeps `client_secret` among the parameters, and says refreshing a rotated token needs the client id and secret. It says nothing about browsers calling its Web API. So the browser path may not work, and the computer sign-in is the dependable one.

Steps:
1. Make a Slack app in a test workspace. Under OAuth, add the user token scopes listed in the vault (channels, groups, im, mpim history and read, users:read). Add the redirect URLs `https://<your node>/vault/connect` and `http://127.0.0.1:8790/callback`. If Slack refuses an http redirect URL, test from the deployed site only.
2. Run the script. Expected: the install page, then either `PASS code exchange with PKCE and no secret` (the browser path can sign in) or a FAIL there and `PASS code exchange with the secret` (use the computer sign-in).
3. Read the line about `allow-origin`. `none` means a browser cannot read Slack's answers: use the computer sign-in for Slack, as in step 6 of Google, with `SIGIL_SLACK_CLIENT_ID` and `SIGIL_SLACK_CLIENT_SECRET` set on your computer.
4. If the script says token rotation is on, sync Slack from the connector only.

## 5. Claude, ChatGPT and Cursor through the connector

**Script:** `run.mjs connector` with `SIGIL_URL` and `SIGIL_APP_KEY` (made in the vault, Apps). It starts the built connector over stdio as an MCP client would.

Expected: `PASS tools`, `PASS list_folders`, `PASS search_memories`, and `PASS read_memory, quoted as data`.

Then by hand, per client:
- **Claude Desktop.** Settings, Developer, Edit Config (or the file `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows). Paste the JSON the vault shows, quit Claude Desktop fully and open it again. Ask: "Search my Sigil memories for <a title you have>". Expected: Claude asks to use the Sigil tool, answers from the memory, and a line appears in the vault's Read log within seconds.
- **Claude Code.** Run the command the vault shows (`claude mcp add sigil --scope user --env ... -- ...`). Run `claude mcp list`: expected `sigil` connected. Ask the same question.
- **Cursor.** Paste the JSON into `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project). In Cursor's MCP settings, expected: `sigil` with its tools listed.
- **ChatGPT.** ChatGPT connects to MCP servers over the internet, not to a program on your computer. Run the connector with `--http` behind an https tunnel you control, add the address as a custom connector in ChatGPT (developer mode), and ask the same question. Expected: the answer and a Read log line. Keep the address private: anyone with it can read what the key can read.

Before announcing it, publish the connector (`npm publish` in `connector/`, by the owner) and set `connectorPublished: true` in `web/src/lib/site.ts`, so the vault shows `npx -y sigil-connector` instead of a path.

## 6. The owner's storage for backups

**Script:** `run.mjs storage` with `SIGIL_CHECK_TARGET_FILE` pointing at a JSON file with one target, in the shape of the vault's Storage form:

```json
{ "kind": "s3", "id": "check-0001", "label": "Test bucket", "endpoint": "https://s3.eu-west-1.amazonaws.com", "region": "eu-west-1", "bucket": "<bucket>", "prefix": "sigil-check/", "accessKeyId": "<key id>", "secretAccessKey": "<secret>" }
```

For IPFS (Pinata): `{ "kind": "ipfs", "id": "check-0002", "label": "Pinata", "api": "pinata", "endpoint": "https://api.pinata.cloud", "token": "<JWT>", "gateway": "https://<your gateway>" }`. For Arweave, use a wallet with a very small balance: what is stored there stays for good.

Expected: `PASS put` with the place, and `PASS get, the same bytes`. Then in the vault, Storage: add the same target, run a backup, and restore it on a second node (`/vault/restore`, from the public address). Expected: the restore report lists your folders and memories, and signing in on the second node opens the vault. The bucket needs CORS for the site's origin (PUT, GET) for backups made in the browser; the connector's backups need none.

## 7. Voice: the speech model

**Script:** `run.mjs speech-model` with `SIGIL_URL`.

Expected: each file of `Xenova/whisper-tiny.en` (or the model in `SIGIL_SPEECH_MODEL`) answers 200, and the script prints each size and the total a phone downloads once (write the total down for the docs and the privacy page); the first request on a new node takes longer while the node fetches the file once from the model hub (turn `SIGIL_MODEL_FETCH=off` after that to serve only what it holds). Then on a phone, in the AI self's test chat, turn voice on, allow the microphone and speak a sentence. Expected: the words appear in the question box after a few seconds, with nothing sent anywhere but the model files fetched from the node.

## 8. Sharing to Sigil on Android (Web Share Target)

No script: it needs a phone.

1. On an Android phone, open the node in Chrome, sign in, and install it (menu, Add to home screen, Install).
2. In another app, share a piece of text or a link, and choose Sigil in the share sheet.

Expected: Sigil opens on the capture screen with the text filled in; sending it puts a sealed suggestion in the vault's Inbox. Sharing a photo attaches it. Chrome lists an app as a share target only once it is installed. On Android the shared link usually arrives in the text, not in the url field: check that it is kept.

## 9. The Apple Shortcut capture

**Script:** `run.mjs capture` with `SIGIL_URL` and `SIGIL_CAPTURE_KEY` (made in the vault, Devices, Capture keys, with "Also take plain text from a shortcut that cannot run code" ticked). Expected: `PASS sent to the inbox`, and the suggestion in the Inbox from that key.

Then on an iPhone: make the shortcut as the vault describes (Get Contents of URL, POST, the address `/api/capture/v1/text`, header `authorization: Bearer <token shown in the vault>`, JSON body with `text`). Run it from the share sheet on a selection. Expected: the same suggestion in the Inbox, marked as plain text that reached the node before it was sealed.

## 10. The contracts on a test network

**Script:** `sh scripts/live-checks/contracts.sh` with `SIGIL_TESTNET_RPC` set to a test network's RPC address. It refuses main networks and asks for the deployer key without showing it.

1. Fund a fresh test-network address with test funds only.
2. Run the script. Expected: addresses for SigilSeal and SigilSelfRegistry.
3. On a test node, set `SIGIL_ANCHOR=on`, `SIGIL_ANCHOR_RPC_URL`, `SIGIL_SEAL_CONTRACT` and `SIGIL_SEALER_KEY` (the sealer, a key used for nothing else), and `SIGIL_CHAIN_READ_RPC` to a public read-only address. After the next full hour, expected: `/status` shows seals on chain, and on `/seals` a proof checks against the contract in the browser.
4. Deploy one SigilSelfWallet for a test owner (`DeploySigilSelfWallet` in the same script file), set its rules from the vault's Identity tab, and send one small payment within the caps and one above them. Expected: the first goes through, the second reverts with `OverTxCap`.

The real deploys wait for the owner's explicit yes, with each address read back before anything is sent.

## 11. The immune system's public test with a real model

With `SIGIL_IMMUNE_MODEL=stub` the test runs against a model that follows every instruction it can read, and costs nothing. With a model key in `SIGIL_IMMUNE_MODEL` (Anthropic or OpenAI), the node calls that model once per strain every hour: twelve calls an hour, at the key owner's cost. Before switching that on, run one round locally against a test node and read `/immune`: expected one row per strain, most held by the scanner, and every result checking against its seal ("Check it").

## 12. A big vault on a phone

1. `SIGIL_PERF_MEMORIES=10000 npm run seed` writes a vault of 10,000 memories to `web/.data-seed/sigil.db` and prints its recovery phrase.
2. Start a test node on that data (`SIGIL_DATA_DIR=web/.data-seed`, a port other than the one you use every day) and reach it from a phone over https (a tunnel you control).
3. Sign in with the recovery phrase and time how long the vault takes to open; then search, open the timeline and scroll it.

Expected: under the phone budget in docs/PERFORMANCE.md (four times the laptop's). Write the time down there, replacing the assumption.
