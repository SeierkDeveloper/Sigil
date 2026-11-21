// Every route of the API, called with bodies of every odd shape, signed in as
// a vault, as a connected app and as nobody. Whatever arrives, the answer is a
// plain refusal or a success: never a server error, never a crash.

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { appKeys, parseAppKey, randomId } from "@sigil/core";
import { harness, signedUp, ORIGIN, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import { resetRateLimits } from "../src/server/http";
import { FUZZ_RUNS, int, json, pick, rng, str } from "../../packages/core/test/fixtures/fuzz";

const ROUTES = [...readFileSync(path.resolve(import.meta.dirname, "../src/server/api.ts"), "utf8").matchAll(/route\("(GET|POST|PUT|PATCH|DELETE)", "([^"]+)"/g)].map((m) => ({ method: m[1], pattern: m[2] }));

let h: Harness;
let cookie: string;
let bearer: string;
let ids: string[];

beforeAll(async () => {
  h = harness();
  const o = await signedUp(h);
  cookie = `sigil_session=${o.b.cookie()}`;
  const app = await ops.connectApp(o.b.api, o.vault, { name: "Fuzz", kind: "other" }, o.data.folders);
  bearer = (await appKeys(parseAppKey(app.appKey).secret)).authToken;
  // Ids that exist, so routes get past "not found" now and then.
  ids = [o.data.folders[0].id, app.appId, randomId(), "aaaaaaaa", "__proto__"];
});

function fill(pattern: string, r: () => number): string {
  return pattern
    .split("/")
    .map((p) => (p.startsWith(":") ? (r() < 0.7 ? pick(r, ids) : str(r, 10).replace(/[^A-Za-z0-9_-]/g, "") || "x") : p))
    .join("/");
}

describe("the API under odd input", () => {
  it(`answers ${ROUTES.length} routes without a server error, whatever the body`, async () => {
    expect(ROUTES.length).toBeGreaterThan(150);
    const r = rng();
    const failures: string[] = [];
    const runs = Math.max(4, Math.floor(FUZZ_RUNS / 15));
    for (const route of ROUTES) {
      for (let i = 0; i < runs; i++) {
        resetRateLimits();
        const p = fill(route.pattern, r);
        const who = int(r, 3);
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (who === 0) Object.assign(headers, { cookie, origin: ORIGIN });
        if (who === 1) headers.authorization = `Bearer ${bearer}`;
        const kind = int(r, 4);
        const body = route.method === "GET" || route.method === "DELETE" ? undefined : kind === 0 ? str(r, 200) : kind === 1 ? "{" : JSON.stringify(json(r));
        const res = await h.raw(route.method, p, { body, headers });
        if (res.status >= 500) failures.push(`${route.method} ${p} -> ${res.status} ${await res.text()}`);
        else if (res.status >= 400) {
          const data = (await res.json()) as { error?: unknown };
          if (typeof data.error !== "string" || !data.error) failures.push(`${route.method} ${p} -> ${res.status} without a message`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
