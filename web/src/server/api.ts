// The whole HTTP API in one router. app/api/[...path]/route.ts hands every
// request here, and the tests call it directly with plain Request objects.
//
// Two kinds of callers:
//   the vault page   -> session cookie, same-origin checked
//   a connected app  -> "Authorization: Bearer <app token>", read only, every call logged

import { z } from "zod";
import { isEnvelope, randomId } from "@sigil/core";
import { getDb, type Db } from "./db";
import { serverConfig } from "./config";
import {
  addKeyslot,
  appByToken,
  appFolders,
  appIndex,
  appRead,
  createApp,
  createFolder,
  createSession,
  createUser,
  deleteAccount,
  deleteApp,
  deleteFolder,
  deleteMemories,
  deleteSession,
  HttpError,
  keyslotByToken,
  keyslotForPasskey,
  listApps,
  listFolders,
  listKeyslots,
  listLog,
  listMemories,
  logEntry,
  logRead,
  putMemories,
  removeKeyslot,
  renameFolder,
  revokeApp,
  sessionUser,
  setGrants,
  userExists,
  vaultUsage,
  type AppAuth,
} from "./store";
import { getSeal, listSeals, proofFor, proofForLeaf, publicStats, sealPending, sealQueue, sealStats } from "./seal";
import { anchorStatus } from "./anchor";
import {
  assertSameOrigin,
  clearSessionCookie,
  clientIp,
  errorResponse,
  getCookie,
  json,
  rateLimit,
  readJson,
  SESSION_COOKIE,
  sessionCookie,
} from "./http";
import { authenticationOptions, registrationOptions, verifyAuthentication, verifyRegistration } from "./webauthn";

// ---------------------------------------------------------------- input shapes

const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "Invalid id");
const envelope = (max: number) => z.string().max(max).refine(isEnvelope, "Expected encrypted data");
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Invalid token");
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Invalid wallet address")
  .transform((a) => a.toLowerCase());
const lookupId = z.string().regex(/^[0-9a-f]{32}$/, "Invalid recovery id");

const folderShape = z.object({ id, meta: envelope(4096), wrappedKey: envelope(256) });
const memoryShape = z.object({ id, folderId: id, head: envelope(64_000), body: envelope(3_000_000) });
const grantShape = z.object({ folderId: id, wrappedKey: envelope(256) });
const appShape = z.object({
  id,
  meta: envelope(4096),
  secret: envelope(256),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  grants: z.array(grantShape).max(200),
});
const recoveryShape = z.object({ lookupId, authToken: token, wrappedKey: envelope(256) });
const vaultInitShape = z.object({ wrappedKey: envelope(256), recovery: recoveryShape, folder: folderShape });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new HttpError(400, `Invalid request: ${issue.path.join(".") || "body"}: ${issue.message}`, "invalid");
  }
  return r.data;
}

const KB = 1024;
const MB = 1024 * KB;

// ---------------------------------------------------------------- context

interface Ctx {
  req: Request;
  db: Db;
  method: string;
  path: string[];
  url: URL;
}

function userOf(ctx: Ctx): string {
  const userId = sessionUser(ctx.db, getCookie(ctx.req, SESSION_COOKIE));
  if (!userId) throw new HttpError(401, "Please sign in to your vault.", "signed_out");
  if (ctx.method !== "GET") assertSameOrigin(ctx.req);
  return userId;
}

function appOf(ctx: Ctx): AppAuth {
  const header = ctx.req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9_-]{43})$/.exec(header.trim());
  rateLimit(`app-ip:${clientIp(ctx.req)}`, 600, 60_000);
  const auth = m ? appByToken(ctx.db, m[1]) : null;
  if (!auth) throw new HttpError(401, "This app key was revoked or does not exist. Create a new one in your Sigil vault.", "app_revoked");
  rateLimit(`app:${auth.appId}`, 240, 60_000);
  return auth;
}

function signedIn(ctx: Ctx, userId: string, body: Record<string, unknown>): Response {
  const sessionToken = createSession(ctx.db, userId);
  return json({ userId, ...body }, 200, { "set-cookie": sessionCookie(ctx.req, sessionToken, serverConfig.sessionDays * 86400) });
}

function authLimit(ctx: Ctx) {
  rateLimit(`auth:${clientIp(ctx.req)}`, 40, 60_000);
}

// ---------------------------------------------------------------- routes

type Handler = (ctx: Ctx, params: string[]) => Promise<Response> | Response;
const routes: [string, string, Handler][] = [];
const route = (method: string, pattern: string, handler: Handler) => routes.push([method, pattern, handler]);

// ---- public

const STARTED_AT = Date.now();

route("GET", "status", (ctx) => {
  const anchor = anchorStatus();
  // The seal job runs here too, so the page that shows this always shows a finished job or a real fault.
  let job: "ok" | "off" | "failed" = serverConfig.sealsEnabled ? "ok" : "off";
  try {
    sealPending(ctx.db);
  } catch {
    job = "failed";
  }
  const queue = sealQueue(ctx.db);
  if (job === "ok" && queue.overdue > 0) job = "failed";
  return json({
    ok: true,
    time: new Date().toISOString(),
    upSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    database: "ok",
    seals: { enabled: serverConfig.sealsEnabled, periodSeconds: serverConfig.sealSeconds, mode: anchor.mode, job, ...queue, ...sealStats(ctx.db) },
  });
});

route("GET", "stats", (ctx) => {
  rateLimit(`public:${clientIp(ctx.req)}`, 240, 60_000);
  return json(publicStats(ctx.db));
});

route("GET", "seals", (ctx) => {
  sealPending(ctx.db);
  const limit = Math.min(Math.max(Number(ctx.url.searchParams.get("limit")) || 24, 1), 200);
  const anchor = anchorStatus();
  return json({ mode: anchor.mode, periodSeconds: serverConfig.sealSeconds, seals: listSeals(ctx.db, limit) });
});

const sealHour = (value: string) => {
  if (!/^\d{1,12}$/.test(value)) throw new HttpError(400, "Invalid seal number.", "invalid");
  return Number(value);
};

route("GET", "seals/:hour", (ctx, [hour]) => {
  rateLimit(`public:${clientIp(ctx.req)}`, 240, 60_000);
  sealPending(ctx.db);
  const seal = getSeal(ctx.db, sealHour(hour));
  if (!seal) throw new HttpError(404, "There is no seal with that number.", "no_seal");
  return json({ mode: anchorStatus().mode, periodSeconds: serverConfig.sealSeconds, seal });
});

// Anyone holding a fingerprint can ask for its proof. The fingerprint is a salted
// hash, so neither the question nor the answer shows what was read, or by whom.
route("GET", "seals/:hour/proof", (ctx, [hour]) => {
  rateLimit(`public:${clientIp(ctx.req)}`, 240, 60_000);
  sealPending(ctx.db);
  const leaf = (ctx.url.searchParams.get("leaf") ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(leaf)) throw new HttpError(400, "A fingerprint is 0x followed by 64 hex characters.", "invalid");
  const n = sealHour(hour);
  if (!getSeal(ctx.db, n)) throw new HttpError(404, "There is no seal with that number.", "no_seal");
  const proof = proofForLeaf(ctx.db, n, leaf);
  if (!proof) throw new HttpError(404, "That fingerprint is not part of this seal.", "not_in_seal");
  return json(proof);
});

// ---- session

route("GET", "session", (ctx) => {
  const userId = sessionUser(ctx.db, getCookie(ctx.req, SESSION_COOKIE));
  return json({ signedIn: !!userId && userExists(ctx.db, userId) });
});

route("POST", "auth/logout", (ctx) => {
  const t = getCookie(ctx.req, SESSION_COOKIE);
  if (t) deleteSession(ctx.db, t);
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(ctx.req) });
});

// ---- passkey

route("POST", "auth/passkey/register/options", async (ctx) => {
  authLimit(ctx);
  assertSameOrigin(ctx.req);
  return json(await registrationOptions(ctx.db, ctx.req, randomId()));
});

route("POST", "auth/passkey/register", async (ctx) => {
  authLimit(ctx);
  assertSameOrigin(ctx.req);
  const body = parse(z.object({ challengeId: id, response: z.record(z.string(), z.unknown()) }).and(vaultInitShape), await readJson(ctx.req, 64 * KB));
  const { userId, passkey } = await verifyRegistration(ctx.db, ctx.req, body.challengeId, body.response);
  createUser(
    ctx.db,
    {
      primary: { kind: "passkey", ref: passkey.credentialId, wrappedKey: body.wrappedKey },
      recovery: { kind: "phrase", ref: body.recovery.lookupId, authToken: body.recovery.authToken, wrappedKey: body.recovery.wrappedKey },
      folder: body.folder,
      passkey,
    },
    userId,
  );
  return signedIn(ctx, userId, {});
});

route("POST", "auth/passkey/login/options", async (ctx) => {
  authLimit(ctx);
  assertSameOrigin(ctx.req);
  return json(await authenticationOptions(ctx.db, ctx.req));
});

route("POST", "auth/passkey/login", async (ctx) => {
  authLimit(ctx);
  assertSameOrigin(ctx.req);
  const body = parse(z.object({ challengeId: id, response: z.record(z.string(), z.unknown()) }), await readJson(ctx.req, 64 * KB));
  const { userId, credentialId } = await verifyAuthentication(ctx.db, ctx.req, body.challengeId, body.response);
  const slot = keyslotForPasskey(ctx.db, credentialId);
  if (!slot) throw new HttpError(404, "This passkey is no longer linked to a vault.", "unknown_passkey");
  return signedIn(ctx, userId, { keyslot: { kind: slot.kind, wrappedKey: slot.wrappedKey } });
});

// ---- wallet

route("POST", "auth/wallet/register", async (ctx) => {
  authLimit(ctx);
  assertSameOrigin(ctx.req);
  const body = parse(z.object({ address, authToken: token }).and(vaultInitShape), await readJson(ctx.req, 64 * KB));
  const userId = createUser(ctx.db, {
    primary: { kind: "wallet", ref: body.address, authToken: body.authToken, wrappedKey: body.wrappedKey },
    recovery: { kind: "phrase", ref: body.recovery.lookupId, authToken: body.recovery.authToken, wrappedKey: body.recovery.wrappedKey },
    folder: body.folder,
  });
  return signedIn(ctx, userId, {});
});

route("POST", "auth/wallet/login", async (ctx) => {
  authLimit(ctx);
  assertSameOrigin(ctx.req);
  const body = parse(z.object({ address, authToken: token }), await readJson(ctx.req, 8 * KB));
  const slot = keyslotByToken(ctx.db, "wallet", body.address, body.authToken);
  if (!slot) throw new HttpError(404, "No vault opens with this wallet. Create one, or sign in another way.", "unknown_wallet");
  return signedIn(ctx, slot.userId, { keyslot: { kind: slot.kind, wrappedKey: slot.wrappedKey } });
});

// ---- recovery phrase

route("POST", "auth/phrase/login", async (ctx) => {
  authLimit(ctx);
  assertSameOrigin(ctx.req);
  const body = parse(z.object({ lookupId, authToken: token }), await readJson(ctx.req, 8 * KB));
  const slot = keyslotByToken(ctx.db, "phrase", body.lookupId, body.authToken);
  if (!slot) throw new HttpError(404, "No vault opens with this recovery phrase.", "unknown_phrase");
  return signedIn(ctx, slot.userId, { keyslot: { kind: slot.kind, wrappedKey: slot.wrappedKey } });
});

// ---- sign-in methods on an open vault

route("GET", "keyslots", (ctx) => json({ keyslots: listKeyslots(ctx.db, userOf(ctx)) }));

route("POST", "keyslots/passkey/options", async (ctx) => {
  const userId = userOf(ctx);
  return json(await registrationOptions(ctx.db, ctx.req, userId));
});

route("POST", "keyslots/passkey", async (ctx) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ challengeId: id, response: z.record(z.string(), z.unknown()), wrappedKey: envelope(256) }), await readJson(ctx.req, 64 * KB));
  const { userId: forUser, passkey } = await verifyRegistration(ctx.db, ctx.req, body.challengeId, body.response);
  if (forUser !== userId) throw new HttpError(400, "This passkey was made for another vault.");
  addKeyslot(ctx.db, userId, { kind: "passkey", ref: passkey.credentialId, wrappedKey: body.wrappedKey }, passkey);
  return json({ keyslots: listKeyslots(ctx.db, userId) });
});

route("POST", "keyslots/wallet", async (ctx) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ address, authToken: token, wrappedKey: envelope(256) }), await readJson(ctx.req, 8 * KB));
  addKeyslot(ctx.db, userId, { kind: "wallet", ref: body.address, authToken: body.authToken, wrappedKey: body.wrappedKey });
  return json({ keyslots: listKeyslots(ctx.db, userId) });
});

route("POST", "keyslots/phrase", async (ctx) => {
  const userId = userOf(ctx);
  const body = parse(recoveryShape, await readJson(ctx.req, 8 * KB));
  addKeyslot(ctx.db, userId, { kind: "phrase", ref: body.lookupId, authToken: body.authToken, wrappedKey: body.wrappedKey });
  return json({ keyslots: listKeyslots(ctx.db, userId) });
});

route("DELETE", "keyslots/:id", (ctx, [slotId]) => {
  const userId = userOf(ctx);
  removeKeyslot(ctx.db, userId, slotId);
  return json({ keyslots: listKeyslots(ctx.db, userId) });
});

// ---- the vault

route("GET", "vault", (ctx) => {
  const userId = userOf(ctx);
  return json({
    folders: listFolders(ctx.db, userId),
    memories: listMemories(ctx.db, userId),
    apps: listApps(ctx.db, userId),
    keyslots: listKeyslots(ctx.db, userId),
    usage: vaultUsage(ctx.db, userId),
  });
});

route("GET", "usage", (ctx) => json(vaultUsage(ctx.db, userOf(ctx))));

route("POST", "folders", async (ctx) => {
  const userId = userOf(ctx);
  createFolder(ctx.db, userId, parse(folderShape, await readJson(ctx.req, 16 * KB)));
  return json({ ok: true }, 201);
});

route("PATCH", "folders/:id", async (ctx, [folderId]) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ meta: envelope(4096) }), await readJson(ctx.req, 16 * KB));
  renameFolder(ctx.db, userId, folderId, body.meta);
  return json({ ok: true });
});

route("DELETE", "folders/:id", (ctx, [folderId]) => {
  deleteFolder(ctx.db, userOf(ctx), folderId);
  return json({ ok: true });
});

route("PUT", "memories", async (ctx) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ memories: z.array(memoryShape).min(1).max(500) }), await readJson(ctx.req, 24 * MB));
  return json({ saved: putMemories(ctx.db, userId, body.memories) });
});

route("POST", "memories/delete", async (ctx) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ ids: z.array(id).min(1).max(5000) }), await readJson(ctx.req, 512 * KB));
  return json({ deleted: deleteMemories(ctx.db, userId, body.ids) });
});

route("POST", "apps", async (ctx) => {
  const userId = userOf(ctx);
  createApp(ctx.db, userId, parse(appShape, await readJson(ctx.req, 64 * KB)));
  return json({ ok: true }, 201);
});

route("PUT", "apps/:id/grants", async (ctx, [appId]) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ grants: z.array(grantShape).max(200) }), await readJson(ctx.req, 64 * KB));
  setGrants(ctx.db, userId, appId, body.grants);
  return json({ ok: true });
});

route("POST", "apps/:id/revoke", (ctx, [appId]) => {
  revokeApp(ctx.db, userOf(ctx), appId);
  return json({ ok: true });
});

route("DELETE", "apps/:id", (ctx, [appId]) => {
  deleteApp(ctx.db, userOf(ctx), appId);
  return json({ ok: true });
});

route("GET", "log", (ctx) => {
  const userId = userOf(ctx);
  sealPending(ctx.db);
  const limit = Math.min(Math.max(Number(ctx.url.searchParams.get("limit")) || 200, 1), 1000);
  const before = ctx.url.searchParams.get("before") ?? undefined;
  return json({ periodSeconds: serverConfig.sealSeconds, mode: anchorStatus().mode, entries: listLog(ctx.db, userId, limit, before) });
});

route("GET", "log/:id/proof", (ctx, [entryId]) => {
  const userId = userOf(ctx);
  sealPending(ctx.db);
  const entry = logEntry(ctx.db, userId, entryId);
  if (!entry) throw new HttpError(404, "That log entry was not found.");
  const proof = proofFor(ctx.db, entry);
  if (!proof) throw new HttpError(409, "This entry is not sealed yet. Seals are made once the hour is over.", "not_sealed");
  return json({ entry, ...proof });
});

route("DELETE", "account", (ctx) => {
  const userId = userOf(ctx);
  deleteAccount(ctx.db, userId);
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(ctx.req) });
});

// ---- connected apps (read only)

route("GET", "connector/v1/folders", (ctx) => {
  const auth = appOf(ctx);
  const folders = appFolders(ctx.db, auth);
  logRead(ctx.db, auth, "folders", null, folders.length);
  return json({ appId: auth.appId, folders });
});

route("GET", "connector/v1/index", (ctx) => {
  const auth = appOf(ctx);
  const folders = appFolders(ctx.db, auth);
  const memories = appIndex(ctx.db, auth);
  logRead(ctx.db, auth, "index", null, memories.length);
  return json({ appId: auth.appId, folders, memories });
});

route("POST", "connector/v1/read", async (ctx) => {
  const auth = appOf(ctx);
  const body = parse(z.object({ ids: z.array(id).min(1).max(20) }), await readJson(ctx.req, 16 * KB));
  const unique = [...new Set(body.ids)];
  const { found, missing } = appRead(ctx.db, auth, unique);
  for (const m of found) logRead(ctx.db, auth, "read", m.id, 1);
  const folders = appFolders(ctx.db, auth).filter((f) => found.some((m) => m.folderId === f.id));
  return json({ appId: auth.appId, folders, memories: found, missing });
});

// ---------------------------------------------------------------- dispatch

function match(pattern: string, path: string[]): string[] | null {
  const parts = pattern.split("/");
  if (parts.length !== path.length) return null;
  const params: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(":")) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(path[i])) return null;
      params.push(path[i]);
    } else if (parts[i] !== path[i]) return null;
  }
  return params;
}

export async function handleApi(req: Request, path: string[], db: Db = getDb()): Promise<Response> {
  const ctx: Ctx = { req, db, method: req.method.toUpperCase(), path, url: new URL(req.url) };
  try {
    let pathMatched = false;
    for (const [method, pattern, handler] of routes) {
      const params = match(pattern, path);
      if (!params) continue;
      pathMatched = true;
      if (method === ctx.method) return await handler(ctx, params);
    }
    if (pathMatched) return json({ error: "Method not allowed.", code: "method" }, 405);
    return json({ error: "Not found.", code: "not_found" }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}
