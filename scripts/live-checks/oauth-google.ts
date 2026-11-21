// Google sign-in for live sync with a real client, on this computer:
// the authorization request, the code exchange with PKCE (with and without a
// client secret), one read-only call. Tokens are never printed.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { authorizeUrl, exchangeCode, newPkce, SYNC_INFO, type SyncKind } from "../../packages/core/src/sync/oauth";
import { ask, bad, done, note, ok, secretShape } from "./lib";

const clientId = await ask("SIGIL_GOOGLE_CLIENT_ID", "Google OAuth client id");
const secret = await ask("SIGIL_GOOGLE_CLIENT_SECRET", "Client secret, only for a Desktop client", { secret: true, optional: true });
const kind = ((await ask("SIGIL_CHECK_KIND", "Which source: gmail, calendar or drive", { optional: true })) || "gmail") as SyncKind;
note(`client secret: ${secretShape(secret)}`);

const pkce = newPkce();
const code = await new Promise<{ code: string; redirectUri: string }>((resolve) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/callback") return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/plain" }).end("You can close this window.");
    server.close();
    if (u.searchParams.get("state") !== pkce.state) bad("state", "the state that came back is not the one sent");
    resolve({ code: u.searchParams.get("code") ?? "", redirectUri });
  });
  let redirectUri = "";
  server.listen(0, "127.0.0.1", () => {
    redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
    process.stdout.write(`\nOpen this address, sign in with a test account and allow the read-only scope:\n\n${authorizeUrl({ kind, clientId, redirectUri, pkce })}\n\n`);
  });
});
if (!code.code) {
  bad("authorization", "no code came back");
  done();
}
ok("authorization", `scope ${SYNC_INFO[kind].scopes.join(" ")}`);
try {
  const r = await exchangeCode({ kind, clientId, redirectUri: code.redirectUri, code: code.code, verifier: pkce.verifier, clientSecret: secret || undefined });
  ok(secret ? "code exchange with PKCE and the client secret" : "code exchange with PKCE and no secret", `access token ${secretShape(r.tokens.access)}, refresh token ${secretShape(r.tokens.refresh)}, ends ${r.tokens.expiresAt}`);
  if (!r.tokens.refresh) bad("refresh token", "none: check access_type=offline and prompt=consent, and that the test account had not granted it before");
  const api = kind === "gmail" ? "https://gmail.googleapis.com/gmail/v1/users/me/profile" : kind === "calendar" ? "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1" : "https://www.googleapis.com/drive/v3/files?pageSize=1";
  const read = await fetch(api, { headers: { authorization: `Bearer ${r.tokens.access}` } });
  read.ok ? ok("one read-only call", `${read.status}`) : bad("one read-only call", `${read.status}`);
  const cors = await fetch("https://oauth2.googleapis.com/token", { method: "OPTIONS", headers: { origin: "https://sigil.fun", "access-control-request-method": "POST" } });
  note(`token endpoint CORS preflight from a browser origin: ${cors.status}, allow-origin ${cors.headers.get("access-control-allow-origin") ?? "none"}`);
} catch (err) {
  bad("code exchange", (err as Error).message);
  if (/client_secret/i.test((err as Error).message)) note("Google wants a client secret for this client type: use the sign-in on the owner's computer (sigil-connector connect) with a Desktop client.");
}
done();
