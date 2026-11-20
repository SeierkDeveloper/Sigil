// The model files the vault page loads for search by meaning, and the database
// upgrade from the first version of the schema.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { handleModel } from "../src/server/models";
import { openDb } from "../src/server/db";
import { harness } from "./helpers";

const FIXTURE = path.resolve(import.meta.dirname, "../../packages/core/test/fixtures/tiny-model");
const MODEL = "sigil/tiny-embedder";
const get = (p: string) => new Request(`http://localhost:3000/models/${p}`);
const env = { ...process.env };

beforeEach(() => {
  process.env.SIGIL_EMBED_MODEL = MODEL;
  process.env.SIGIL_MODEL_DIR = FIXTURE;
  process.env.SIGIL_MODEL_FETCH = "off";
});
afterEach(() => {
  process.env = { ...env };
});

describe("model files", () => {
  it("serves the configured model's files from disk", async () => {
    const res = await handleModel(get(""), [...MODEL.split("/"), "tokenizer.json"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).model.type).toBe("WordPiece");
    const onnx = await handleModel(get(""), [...MODEL.split("/"), "onnx", "model_quantized.onnx"]);
    expect(onnx.status).toBe(200);
    expect(new Uint8Array(await onnx.arrayBuffer())).toEqual(new Uint8Array(await readFile(path.join(FIXTURE, MODEL, "onnx/model_quantized.onnx"))));
  });

  it("serves nothing else", async () => {
    for (const parts of [
      ["other", "model", "tokenizer.json"],
      [...MODEL.split("/"), "config.json"],
      [...MODEL.split("/"), "..", "..", "..", "package.json"],
      [...MODEL.split("/")],
    ]) {
      expect((await handleModel(get(""), parts)).status, parts.join("/")).toBe(404);
    }
    expect((await handleModel(new Request("http://localhost:3000/models/x", { method: "POST" }), [...MODEL.split("/"), "tokenizer.json"])).status).toBe(405);
    process.env.SIGIL_SEMANTIC = "off";
    expect((await handleModel(get(""), [...MODEL.split("/"), "tokenizer.json"])).status).toBe(404);
  });

  it("fetches a missing file once when allowed, and keeps it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sigil-web-models-"));
    process.env.SIGIL_MODEL_DIR = dir;
    expect((await handleModel(get(""), [...MODEL.split("/"), "tokenizer.json"])).status).toBe(404);
    process.env.SIGIL_MODEL_FETCH = "on";
    const asked: string[] = [];
    const hub = (async (url: string) => {
      asked.push(url);
      return new Response(await readFile(path.join(FIXTURE, MODEL, "tokenizer.json")));
    }) as unknown as typeof fetch;
    expect((await handleModel(get(""), [...MODEL.split("/"), "tokenizer.json"], hub)).status).toBe(200);
    expect((await handleModel(get(""), [...MODEL.split("/"), "tokenizer.json"], hub)).status).toBe(200);
    expect(asked).toEqual([`https://huggingface.co/${MODEL}/resolve/main/tokenizer.json`]);
    expect(existsSync(path.join(dir, MODEL, "tokenizer.json"))).toBe(true);
    const down = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect((await handleModel(get(""), [...MODEL.split("/"), "tokenizer_config.json"], down)).status).toBe(502);
  });

  it("tells the vault page which model to load", async () => {
    const h = harness();
    expect(await (await h.raw("GET", "semantic")).json()).toEqual({ enabled: true, model: MODEL });
  });
});

describe("upgrading the database", () => {
  it("keeps every read-log row and allows the new kinds", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sigil-migrate-"));
    const file = path.join(dir, "old.db");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE read_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, app_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('folders', 'index', 'read')), memory_id TEXT, count INTEGER NOT NULL, at TEXT NOT NULL,
        salt TEXT NOT NULL, leaf TEXT NOT NULL, hour INTEGER NOT NULL, sealed INTEGER NOT NULL DEFAULT 0);
      INSERT INTO users VALUES ('u1', '2026-01-01');
      INSERT INTO read_log VALUES ('e1', 'u1', 'a1', 'read', 'm1', 1, '2026-01-01T00:00:00.000Z', 'ab', '0x01', 5, 1);
      PRAGMA user_version = 1;`);
    old.close();
    const db = openDb(file);
    expect(db.prepare("SELECT id, kind, sealed FROM read_log").all()).toEqual([{ id: "e1", kind: "read", sealed: 1 }]);
    db.prepare("INSERT INTO read_log VALUES ('e2', 'u1', 'a1', 'propose', 'p1', 1, '2026-01-01T00:00:01.000Z', 'cd', '0x02', 5, 0)").run();
    expect(() => db.prepare("INSERT INTO read_log VALUES ('e3', 'u1', 'a1', 'write', null, 1, 'x', 'ef', '0x03', 5, 0)").run()).toThrow();
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    db.close();
    // Opening again changes nothing.
    const again = openDb(file);
    expect(again.prepare("SELECT COUNT(*) AS n FROM read_log").get()).toEqual({ n: 2 });
    again.close();
  });
});
