// Running your own node: the container files are checked as written (no image
// is built in tests), against what the site actually reads and serves.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { harness } from "./helpers";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

describe("the node's container", () => {
  const dockerfile = read("Dockerfile");
  const compose = read("compose.yaml");
  const ignore = read(".dockerignore");
  const config = read("web/src/server/config.ts") + read("web/next.config.ts") + read("web/src/server/db.ts");

  it("builds the site on Node 22.13 or newer and runs it as an unprivileged user, with its data in a volume", () => {
    const froms = [...dockerfile.matchAll(/^FROM node:(\d+)\.(\d+)/gm)];
    expect(froms.length).toBe(2);
    for (const [, major, minor] of froms) expect(Number(major) > 22 || (Number(major) === 22 && Number(minor) >= 13)).toBe(true);
    expect(dockerfile).toMatch(/^USER sigil$/m);
    // No VOLUME line: Railway mounts its own volume at /data and compose mounts one.
    expect(dockerfile).not.toMatch(/^VOLUME /m);
    expect(dockerfile).toMatch(/SIGIL_DATA_DIR=\/data/);
    expect(dockerfile).toMatch(/^EXPOSE 3000$/m);
    // The server is the container's own process (no npm or shell in between), so a stop signal reaches it.
    expect(dockerfile).toMatch(/^WORKDIR \/app\/web$/m);
    expect(dockerfile).toMatch(/^STOPSIGNAL SIGTERM$/m);
    expect(dockerfile).toMatch(/^CMD \["node", "\.\.\/node_modules\/next\/dist\/bin\/next", "start"\]$/m);
    expect(dockerfile).toContain("/api/health");
    // What the content security policy is built from must reach the build.
    for (const arg of ["NEXT_PUBLIC_SITE_URL", "SIGIL_BACKUP_ORIGINS", "SIGIL_CHAIN_READ_RPC", "SIGIL_IDENTITY_READ_RPC"]) expect(dockerfile).toMatch(new RegExp(`^ARG ${arg}=`, "m"));
  });

  it("is started with one command, maps the port, keeps the volume and checks the node's health", () => {
    expect(compose).toContain("docker compose up -d --build");
    expect(compose).toMatch(/- "\$\{SIGIL_PORT:-8080\}:3000"/);
    expect(compose).toMatch(/- sigil-data:\/data/);
    expect(compose).toMatch(/healthcheck:\n\s+test: \[.*\/api\/health/);
    expect(compose).not.toContain("3000:3000");
    // Every setting it passes is one the site reads.
    for (const [, name] of compose.matchAll(/^\s{6}(SIGIL_[A-Z_]+):/gm)) {
      if (name === "SIGIL_PORT") continue;
      expect(config, name).toContain(name);
    }
    // No secret or key is ever baked into the files.
    expect(compose + dockerfile).not.toMatch(/SIGIL_SEALER_KEY|API_KEY|SECRET/);
  });

  it("leaves local data, secrets and what the site does not need out of the image", () => {
    for (const p of ["**/node_modules", "**/.data", ".env", ".git", "contracts", "e2e"]) expect(ignore.split("\n")).toContain(p);
  });

  it("answers its health check without a session, naming the node and its standard", async () => {
    const h = harness("https://node.example");
    const res = await h.raw("GET", "health");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toMatchObject({ ok: true, node: { origin: "https://node.example", version: expect.any(String), spec: "1.5.0" } });
  });

  it("runs on Railway from the same Dockerfile, with its health check and one replica on one volume", () => {
    const railway = read("railway.toml");
    expect(railway).toMatch(/^builder = "DOCKERFILE"$/m);
    expect(railway).toMatch(/^dockerfilePath = "Dockerfile"$/m);
    expect(railway).toMatch(/^healthcheckPath = "\/api\/health"$/m);
    expect(railway).toMatch(/^numReplicas = 1$/m);
    expect(railway).toContain("/data");
    expect(railway).toContain("RAILWAY_RUN_UID=0");
    // Every setting named in the example is one the site reads.
    const example = read("web/.env.example");
    for (const [, name] of example.matchAll(/^(SIGIL_[A-Z_]+)=/gm)) expect(config + read("web/src/server/anchor.ts") + read("web/src/server/models.ts"), name).toContain(name);
  });
});
