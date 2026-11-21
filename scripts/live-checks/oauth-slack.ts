// Slack sign-in for live sync with a real app, on this computer: the user-token
// request, the code exchange with PKCE (with and without the client secret),
// auth.test, and what Slack's API answers a browser. Tokens are never printed.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { authorizeUrl, exchangeCode, newPkce } from "../../packages/core/src/sync/oauth";
import { ask, bad, done, note, ok, secretShape } from "./lib";

const clientId = await ask("SIGIL_SLACK_CLIENT_ID", "Slack app client id");
const secret = await ask("SIGIL_SLACK_CLIENT_SECRET", "Slack app client secret", { secret: true, optional: true });
const port = Number((await ask("SIGIL_CHECK_PORT", "Loopback port listed as a redirect URL in the Slack app", { optional: true })) || 8790);
note(`client secret: ${secretShape(secret)}`);
const pkce = newPkce();
const redirectUri = `http://127.0.0.1:${port}/callback`;
const code = await new Promise<string>((resolve) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/callback") return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/plain" }).end("You can close this window.");
    server.close();
    if (u.searchParams.get("state") !== pkce.state) bad("state", "the state that came back is not the one sent");
    resolve(u.searchParams.get("code") ?? "");
  });
  server.listen(port, "127.0.0.1", () => {
    void (server.address() as AddressInfo);
    process.stdout.write(`\nOpen this address and install the app in a test workspace:\n\n${authorizeUrl({ kind: "slack", clientId, redirectUri, pkce })}\n\n`);
  });
});
if (!code) {
  bad("authorization", "no code came back (Slack may require https redirect URLs: then test from the deployed site)");
  done();
}
ok("authorization");
for (const withSecret of secret ? [false, true] : [false]) {
  try {
    const r = await exchangeCode({ kind: "slack", clientId, redirectUri, code, verifier: pkce.verifier, clientSecret: withSecret ? secret : undefined });
    ok(withSecret ? "code exchange with the secret" : "code exchange with PKCE and no secret", `user token ${secretShape(r.tokens.access)}, refresh ${secretShape(r.tokens.refresh)}, workspace ${r.account}`);
    const test = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://sigilvault.fun" }, body: new URLSearchParams({ token: r.tokens.access }) });
    const t = (await test.json()) as { ok?: boolean; error?: string };
    t.ok ? ok("auth.test as a form post") : bad("auth.test", t.error);
    note(`allow-origin on a form post from a browser origin: ${test.headers.get("access-control-allow-origin") ?? "none"} (none means the browser cannot read Slack's answers: use the computer sign-in)`);
    if (r.tokens.refresh) note("Token rotation is on: refreshing needs the client secret, so sync from the connector (sigil-connector connect).");
    break;
  } catch (err) {
    bad(withSecret ? "code exchange with the secret" : "code exchange without a secret", (err as Error).message);
    if (!withSecret) note("Slack wants the client secret at the token step: use the sign-in on the owner's computer (sigil-connector connect).");
  }
}
done();
