// Signing a live sync source in on the owner's computer.
//
// Some providers want a client secret when a sign-in code is traded for tokens
// (Slack always does; Google does for some client types). A browser cannot keep
// a secret, and Sigil's server must never see a token. So the vault can make a
// source that waits for this computer: it hands the source to this app, and
// here the provider's sign-in runs with a redirect to this machine only
// (http://127.0.0.1:<port>/callback), the code is traded with the client id
// and secret from this machine's environment, and the tokens are sealed for
// this app's key before they go to Sigil. From then on `--watch` keeps the
// source in sync from here.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  authorizeUrl,
  exchangeCode,
  newPkce,
  openSyncForApp,
  sealSyncForApp,
  SYNC_INFO,
  type SyncFetch,
  type SyncState,
} from "@sigil/core";
import type { VaultReader } from "./reader";
import { clientSecretFor } from "./sync";

interface WireSource {
  id: string;
  folderId: string;
  box: string | null;
  rev: number;
}

export interface ConnectOptions {
  sourceId: string;
  /** 0 picks a free port. A provider that wants the redirect address listed exactly needs a fixed one. */
  port?: number;
  env?: Record<string, string | undefined>;
  fetch?: SyncFetch;
  /** Called with the address to open in a browser. */
  show: (url: string) => void;
  /** How long to wait for the sign-in. */
  timeoutMs?: number;
}

export function clientIdFor(kind: SyncState["kind"], fallback: string, env: Record<string, string | undefined> = process.env): string {
  const v = SYNC_INFO[kind].provider === "google" ? env.SIGIL_GOOGLE_CLIENT_ID : env.SIGIL_SLACK_CLIENT_ID;
  return v?.trim() || fallback;
}

const PAGE = (text: string) =>
  `<!doctype html><meta charset="utf-8"><title>Sigil</title><body style="font:16px system-ui;padding:3rem;max-width:32rem;margin:auto"><p>${text}</p></body>`;

/** Waits for the provider to send the browser back to this machine with a code. */
function waitForCode(state: string, port: number, timeoutMs: number): Promise<{ redirectUri: string; ready: Promise<string> }> {
  return new Promise((resolveOuter, rejectOuter) => {
    let resolveCode: (code: string) => void = () => undefined;
    let rejectCode: (err: Error) => void = () => undefined;
    const ready = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    ready.catch(() => undefined);
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE("This sign-in does not belong to the one this computer started. Close this window and run the command again."));
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE(code ? "Signed in. You can close this window and go back to the terminal." : "The sign-in was cancelled. You can close this window."));
      server.close();
      clearTimeout(timer);
      if (code) resolveCode(code);
      else rejectCode(new Error(error ? `The service said: ${error.replace(/[^\w .-]/g, "").slice(0, 80)}.` : "The sign-in was cancelled."));
    });
    const timer = setTimeout(() => {
      server.close();
      rejectCode(new Error("The sign-in took too long. Run the command again."));
    }, timeoutMs);
    timer.unref?.();
    server.on("error", (err) => rejectOuter(err));
    // Only this machine can reach it.
    server.listen(port, "127.0.0.1", () => {
      const p = (server.address() as AddressInfo).port;
      resolveOuter({ redirectUri: `http://127.0.0.1:${p}/callback`, ready });
    });
  });
}

/** Runs the sign-in for one source and saves its tokens for this app. Returns the account the provider names. */
export async function connectOnThisComputer(reader: VaultReader, opts: ConnectOptions): Promise<{ kind: SyncState["kind"]; account: string }> {
  const env = opts.env ?? process.env;
  const { sources } = await reader.request<{ sources: WireSource[] }>("GET", "sync");
  const src = sources.find((s) => s.id === opts.sourceId);
  if (!src || !src.box) throw new Error("This app does not keep that source in sync. In the vault, under Sync, choose to sign in on your computer with this app.");
  const state = await openSyncForApp(reader.appSecret, reader.appId, src.id, src.box);
  if (!state) throw new Error("The source could not be read with this app's key.");
  const clientId = clientIdFor(state.kind, state.clientId, env);
  if (!clientId) throw new Error(`Set ${SYNC_INFO[state.kind].provider === "google" ? "SIGIL_GOOGLE_CLIENT_ID" : "SIGIL_SLACK_CLIENT_ID"} on this computer first.`);
  const pkce = newPkce();
  const wait = await waitForCode(pkce.state, opts.port ?? 0, opts.timeoutMs ?? 10 * 60_000);
  opts.show(authorizeUrl({ kind: state.kind, clientId, redirectUri: wait.redirectUri, pkce }));
  const code = await wait.ready;
  const { tokens, account } = await exchangeCode({ kind: state.kind, clientId, redirectUri: wait.redirectUri, code, verifier: pkce.verifier, clientSecret: clientSecretFor(state.kind, env), fetch: opts.fetch });
  const next: SyncState = { ...state, clientId, tokens, account, via: "connector", rev: Math.max(state.rev, src.rev) + 1, last: null };
  await reader.request("PUT", `sync/${src.id}`, { box: await sealSyncForApp(reader.appSecret, reader.appId, src.id, next), rev: next.rev });
  return { kind: state.kind, account };
}
