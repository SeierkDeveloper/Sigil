// A deployed node from outside: health, status, headers, the public pages.
import { ask, bad, baseUrl, done, note, ok } from "./lib";

const base = baseUrl(await ask("SIGIL_URL", "Address of the node (https://...)"));
const health = await fetch(`${base}/api/health`);
const h = (await health.json().catch(() => null)) as { ok?: boolean; node?: { origin?: string; spec?: string } } | null;
if (health.ok && h?.ok) ok("health", `origin ${h.node?.origin}, standard ${h.node?.spec}`);
else bad("health", `answered ${health.status}`);
if (h?.node?.origin !== base) bad("origin", `the node names itself ${h?.node?.origin}; set SIGIL_ORIGIN=${base} and redeploy`);
else ok("origin matches the address");

const page = await fetch(`${base}/`);
const csp = page.headers.get("content-security-policy") ?? "";
csp.includes("frame-ancestors 'none'") ? ok("content security policy") : bad("content security policy", "missing or incomplete");
page.headers.get("strict-transport-security") ? ok("HSTS") : bad("HSTS", "missing: is the node running with NODE_ENV=production behind https?");
page.headers.get("x-content-type-options") === "nosniff" ? ok("nosniff") : bad("nosniff");

const status = (await (await fetch(`${base}/api/status`)).json()) as { seals?: { job?: string; mode?: string } };
status.seals?.job === "ok" ? ok("seal job", `mode ${status.seals.mode}`) : bad("seal job", JSON.stringify(status.seals));

for (const path of ["/vault", "/security", "/immune", "/spec", "/status"]) {
  const r = await fetch(`${base}${path}`);
  r.ok ? ok(`page ${path}`) : bad(`page ${path}`, `answered ${r.status}`);
}
const immune = (await (await fetch(`${base}/api/immune`)).json()) as { enabled?: boolean; model?: string };
note(`immune test: ${immune.enabled ? `on, model ${immune.model}` : "off (set SIGIL_IMMUNE_MODEL to run it)"}`);
const xff = await fetch(`${base}/api/stats`, { headers: { "x-forwarded-for": "198.51.100.1" } });
note(`rate limits count the proxy's address (SIGIL_PROXY_HOPS); /api/stats answered ${xff.status}`);
done();
