// The build makes a loadable unpacked extension: every file the manifest and
// the pages point at exists, and nothing reaches outside the extension.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");

describe("the unpacked extension", () => {
  it("builds, and every referenced file is there", () => {
    execFileSync(process.execPath, [path.join(root, "build.mjs")], { cwd: root, stdio: "pipe" });
    const manifest = JSON.parse(readFileSync(path.join(dist, "manifest.json"), "utf8"));
    expect(manifest.manifest_version).toBe(3);
    const files = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, ...manifest.content_scripts.flatMap((c: { js: string[] }) => c.js)];
    for (const html of ["popup.html", "options.html"]) {
      const text = readFileSync(path.join(dist, html), "utf8");
      files.push(...[...text.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]));
    }
    for (const f of files) expect(existsSync(path.join(dist, f)), f).toBe(true);
    expect(files.some((f) => /^https?:/.test(f))).toBe(false);
  });

  it("asks for no access to websites beyond the two chat sites it reads", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "static", "manifest.json"), "utf8"));
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts[0].matches).toEqual(["https://chatgpt.com/*", "https://chat.openai.com/*", "https://claude.ai/*"]);
    expect(manifest.permissions.sort()).toEqual(["activeTab", "contextMenus", "scripting", "storage"]);
  });
});
