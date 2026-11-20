// The whole HTTP API in one router. app/api/[...path]/route.ts hands every
// request here, and the tests call it directly with plain Request objects.
//
// Two kinds of callers:
//   the vault page   -> session cookie, same-origin checked
//   a connected app  -> "Authorization: Bearer <app token>", reads and suggestions only, every call logged

import { z } from "zod";
import { isBoxPublicKey, isEnvelope, isRelayBox, isSealed, isSettingName, isSigningKey, isSpaceRole, randomId } from "@sigil/core";
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
  purgeExpired,
  putMemories,
  setDeleteAfter,
  removeKeyslot,
  renameFolder,
  revokeApp,
  sessionUser,
  setGrants,
  userExists,
  vaultUsage,
  type AppAuth,
} from "./store";
import { appInbox, appInboxStates, approveProposal, createCapture, createProposal, getBoxKey, listProposals, rejectProposal, setAppInbox, setBoxKey } from "./inbox";
import { acceptShare, createShare, leaveShare, listIncoming, listOutgoing, rotateFolder } from "./shares";
import {
  answerQuestion,
  askQuestion,
  createLink,
  deleteLink,
  deleteSetting,
  listLinks,
  listSettings,
  logSelfAnswer,
  MAX_LINK_USES,
  MAX_PER_HOUR,
  pendingFor,
  publicLink,
  putSetting,
  questionStatus,
  revokeLink,
  selfAppIds,
  selfForApp,
  setSelfApp,
} from "./self";
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
  siteOrigin,
} from "./http";
import { authenticationOptions, registrationOptions, verifyAuthentication, verifyRegistration } from "./webauthn";
import {
  answerInvite,
  bundleFor,
  cancelPlan,
  checkIn,
  dismissMissed,
  inviteFor,
  logLegacyAsk,
  markActive,
  markOpened,
  ownerPlan,
  passShare,
  releasedFolders,
  requestRelease,
  savePlan,
  trustedPlans,
} from "./legacy";
import { deviceSlot, findPairing, logDeviceStep, openPairing, pairingById, pickUp, revokeDevice, sendToDevice } from "./devices";
import { agentForget, agentOf, agentProfile, agentRemember, assertTool, createAgent, leaveHandoff, listAgents, ownerHandoffs, pendingHandoffs, pickHandoffs, updateAgent } from "./agents";
import { acceptSpace, addMember, agentSpaceIds, agentSpaces, createSpace, deleteSpace, deleteSpaceMemories, memberFor, putSpaceMemories, rotateSpace, setRole, vaultSpaces } from "./spaces";
import { deleteCertificate, getCertificate, listCertificates, MAX_CERT_BYTES, MAX_CERT_HOURS, presenceCounts, presenceProofs, presenceTask, publishCertificate, recordPresence, rootsFor, setSignKey } from "./life";

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
const isoTime = z.string().max(40).refine((v) => Number.isFinite(Date.parse(v)), "Expected a time");
const memoryShape = z.object({ id, folderId: id, head: envelope(64_000), body: envelope(3_000_000), deleteAfter: isoTime.nullable().optional() });
const grantShape = z.object({ folderId: id, wrappedKey: envelope(256) });
const appShape = z.object({
  id,
  meta: envelope(4096),
  secret: envelope(256),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  grants: z.array(grantShape).max(200),
});
const recoveryShape = z.object({ lookupId, authToken: token, wrappedKey: envelope(256) });
const boxPublicKey = z.string().refine(isBoxPublicKey, "Expected a vault public key");
const sealed = (max: number) => z.string().max(max).refine(isSealed, "Expected a sealed box");
const boxShape = z.object({ publicKey: boxPublicKey, wrappedSecret: envelope(256) });
const vaultInitShape = z.object({ wrappedKey: envelope(256), recovery: recoveryShape, folder: folderShape, box: boxShape.optional() });
const tagShape = z.string().regex(/^[0-9a-f]{64}$/, "Invalid tag");
const relay = (max: number) => z.string().max(max).refine(isRelayBox, "Expected a relay box");
const linkShape = z.object({
  id,
  publicKey: boxPublicKey,
  intro: envelope(4096),
  ownerBox: envelope(128 * 1024),
  appId: id.nullable().optional(),
  appBox: envelope(128 * 1024).nullable().optional(),
  expiresAt: isoTime,
  maxUses: z.number().int().min(1).max(MAX_LINK_USES),
  perHour: z.number().int().min(1).max(MAX_PER_HOUR),
});
const answerShape = z.object({ sealed: relay(64 * 1024), note: sealed(128 * 1024), cited: z.number().int().min(0).max(50) });
const hexTag = z.string().regex(/^[0-9a-f]{64}$/, "Invalid tag");
const personShape = z.object({
  id,
  publicKey: boxPublicKey.nullable(),
  folderIds: z.array(id).max(200),
  self: z.boolean(),
  share: sealed(4096).nullable(),
  bundle: sealed(256 * 1024).nullable(),
  note: sealed(16 * 1024).nullable(),
  inviteIntro: envelope(2048).nullable(),
});
const planShape = z.object({
  id,
  epoch: z.number().int().min(1).max(1_000_000),
  threshold: z.number().int().min(1).max(12),
  periodDays: z.number().int().min(30).max(730),
  check: hexTag,
  ownerBox: envelope(64 * 1024),
  people: z.array(personShape).min(1).max(12),
});
const modeGrant = z.object({ folderId: id, wrappedKey: envelope(256), mode: z.enum(["read", "write"]).optional() });
const agentRulesShape = z.object({ remember: z.boolean(), recall: z.boolean(), forget: z.boolean(), handoff: z.boolean() });
const signKey = z.string().refine(isSigningKey, "Expected a signing key");
const spaceRole = z.string().refine(isSpaceRole, "Expected read, write or admin");
const memberShape = z.object({
  id,
  kind: z.enum(["vault", "agent"]),
  publicKey: boxPublicKey,
  role: spaceRole,
  sealedKey: sealed(1024),
  tag: hexTag,
  label: envelope(1024),
  appId: id.nullable().optional(),
});
const spaceMemoryShape = z.object({ id, folderId: id, head: envelope(64_000), body: envelope(3_000_000) });
const pairingCodeShape = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/, "Invalid code");

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
  // Any vault action counts as alive for the owner's legacy plan.
  markActive(ctx.db, userId);
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

function signedIn(ctx: Ctx, userId: string, body: Record<string, unknown>, keyslotId: string | null = null): Response {
  markActive(ctx.db, userId);
  const sessionToken = createSession(ctx.db, userId, keyslotId);
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
  purgeExpired(ctx.db);
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
  return json({ mode: anchor.mode, periodSeconds: serverConfig.sealSeconds, chain: chainInfo(), seals: listSeals(ctx.db, limit) });
});

/** Where a browser can read the anchored roots itself: only when anchoring is on and a public read address is set. */
function chainInfo(): { contract: string; rpcUrl: string } | null {
  const a = anchorStatus();
  return a.mode === "anchored" && serverConfig.chainReadRpc ? { contract: a.contract, rpcUrl: serverConfig.chainReadRpc } : null;
}

// Published roots for many hours at once, for checking a life certificate.
route("POST", "seals/roots", async (ctx) => {
  rateLimit(`public:${clientIp(ctx.req)}`, 240, 60_000);
  sealPending(ctx.db);
  const body = parse(z.object({ hours: z.array(z.number().int().min(0).max(1e12)).max(MAX_CERT_HOURS) }), await readJson(ctx.req, 512 * KB));
  return json({ roots: rootsFor(ctx.db, body.hours) });
});

// A published life certificate, by its link. Anyone with the link may read it; it holds no content.
route("GET", "certificates/:id", (ctx, [certId]) => {
  rateLimit(`public:${clientIp(ctx.req)}`, 240, 60_000);
  return new Response(getCertificate(ctx.db, certId), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
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
  if (body.box) setBoxKey(ctx.db, userId, body.box);
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
  if (body.box) setBoxKey(ctx.db, userId, body.box);
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

// ---- a paired device: its own secret gives the token and the key that wraps the vault key

route("POST", "auth/device/login", async (ctx) => {
  authLimit(ctx);
  assertSameOrigin(ctx.req);
  const body = parse(z.object({ deviceId: id, authToken: token }), await readJson(ctx.req, 8 * KB));
  const before = deviceSlot(ctx.db, body.deviceId);
  const slot = keyslotByToken(ctx.db, "device", body.deviceId, body.authToken);
  if (!slot) throw new HttpError(404, "This device was removed from the vault. Add it again from a signed-in device.", "unknown_device");
  if (before && !before.lastUsedAt) logDeviceStep(ctx.db, slot.userId, `signed-in-${body.deviceId}`);
  return signedIn(ctx, slot.userId, { keyslot: { kind: slot.kind, wrappedKey: slot.wrappedKey } }, slot.id);
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
  purgeExpired(ctx.db);
  const inbox = appInboxStates(ctx.db, userId);
  const selfApps = selfAppIds(ctx.db, userId);
  return json({
    folders: listFolders(ctx.db, userId),
    memories: listMemories(ctx.db, userId),
    apps: listApps(ctx.db, userId).map((a) => ({ ...a, canPropose: !a.revokedAt && inbox.get(a.id) === true, canAskSelf: !a.revokedAt && selfApps.has(a.id) })),
    settings: listSettings(ctx.db, userId),
    askLinks: listLinks(ctx.db, userId),
    keyslots: listKeyslots(ctx.db, userId),
    usage: vaultUsage(ctx.db, userId),
    box: getBoxKey(ctx.db, userId),
    proposals: listProposals(ctx.db, userId),
    shares: { outgoing: listOutgoing(ctx.db, userId), incoming: listIncoming(ctx.db, userId) },
    legacy: ownerPlan(ctx.db, userId),
    trusted: trustedPlans(ctx.db, userId),
    agents: listAgents(ctx.db, userId),
    spaces: vaultSpaces(ctx.db, userId),
    signKey: getSignKeyFor(ctx.db, userId),
    presence: presenceCounts(ctx.db, userId),
    certificates: listCertificates(ctx.db, userId),
  });
});

function getSignKeyFor(db: Db, userId: string): string | null {
  return presenceTask(db, userId, "").signingKey;
}

route("POST", "vault/sign-key", async (ctx) => {
  const userId = userOf(ctx);
  setSignKey(ctx.db, userId, parse(z.object({ publicKey: signKey }), await readJson(ctx.req, 4 * KB)).publicKey);
  return json({ ok: true }, 201);
});

// A vault made before vault public keys existed gets one the first time it is opened.
route("POST", "vault/box-key", async (ctx) => {
  const userId = userOf(ctx);
  setBoxKey(ctx.db, userId, parse(boxShape, await readJson(ctx.req, 8 * KB)));
  return json({ ok: true }, 201);
});

// Search by meaning: which model the page should load. Its files come from /models.
route("GET", "semantic", () => json({ enabled: serverConfig.semanticEnabled, model: serverConfig.embedModel }));

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

route("POST", "memories/delete-after", async (ctx) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ items: z.array(z.object({ id, deleteAfter: isoTime.nullable() })).min(1).max(5000) }), await readJson(ctx.req, 1 * MB));
  return json({ updated: setDeleteAfter(ctx.db, userId, body.items) });
});

// ---- vault settings: each one an envelope under the vault key

route("PUT", "settings/:name", async (ctx, [name]) => {
  const userId = userOf(ctx);
  if (!isSettingName(name)) throw new HttpError(404, "There is no such setting.", "not_found");
  const body = parse(z.object({ value: envelope(64 * KB) }), await readJson(ctx.req, 80 * KB));
  putSetting(ctx.db, userId, name, body.value);
  return json({ ok: true });
});

route("DELETE", "settings/:name", (ctx, [name]) => {
  const userId = userOf(ctx);
  if (!isSettingName(name)) throw new HttpError(404, "There is no such setting.", "not_found");
  deleteSetting(ctx.db, userId, name);
  return json({ ok: true });
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

route("PUT", "apps/:id/inbox", async (ctx, [appId]) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ enabled: z.boolean(), tag: tagShape.optional() }), await readJson(ctx.req, 8 * KB));
  setAppInbox(ctx.db, userId, appId, body.enabled, body.tag ?? null);
  return json({ ok: true });
});

route("PUT", "apps/:id/self", async (ctx, [appId]) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ config: envelope(128 * KB) }), await readJson(ctx.req, 160 * KB));
  setSelfApp(ctx.db, userId, appId, body.config);
  return json({ ok: true });
});

route("DELETE", "apps/:id/self", (ctx, [appId]) => {
  setSelfApp(ctx.db, userOf(ctx), appId, null);
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

// ---- the inbox

route("GET", "proposals", (ctx) => json({ proposals: listProposals(ctx.db, userOf(ctx)) }));

route("POST", "proposals/:id/approve", async (ctx, [proposalId]) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ memory: memoryShape }), await readJson(ctx.req, 4 * MB));
  approveProposal(ctx.db, userId, proposalId, body.memory);
  return json({ ok: true });
});

route("DELETE", "proposals/:id", (ctx, [proposalId]) => {
  rejectProposal(ctx.db, userOf(ctx), proposalId);
  return json({ ok: true });
});

// ---- sharing

route("POST", "shares", async (ctx) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ id, folderId: id, recipientKey: boxPublicKey, sealedKey: sealed(512), note: envelope(2048) }), await readJson(ctx.req, 16 * KB));
  createShare(ctx.db, userId, body);
  return json({ ok: true }, 201);
});

route("POST", "shares/:id/accept", (ctx, [shareId]) => {
  acceptShare(ctx.db, userOf(ctx), shareId);
  return json({ ok: true });
});

route("DELETE", "shares/:id", (ctx, [shareId]) => {
  leaveShare(ctx.db, userOf(ctx), shareId);
  return json({ ok: true });
});

route("POST", "folders/:id/rotate", async (ctx, [folderId]) => {
  const userId = userOf(ctx);
  const body = parse(
    z.object({
      wrappedKey: envelope(256),
      meta: envelope(4096),
      memories: z.array(memoryShape).max(20_000),
      grants: z.array(z.object({ appId: id, wrappedKey: envelope(256) })).max(200),
      shares: z.array(z.object({ id, sealedKey: sealed(512) })).max(200),
      revoke: z.array(id).max(200),
    }),
    await readJson(ctx.req, 64 * MB),
  );
  rotateFolder(ctx.db, userId, folderId, body);
  return json({ ok: true });
});

// ---- your AI self: links, and the owner's open vault answering them

route("POST", "self/links", async (ctx) => {
  const userId = userOf(ctx);
  createLink(ctx.db, userId, parse(linkShape, await readJson(ctx.req, 300 * KB)));
  return json({ ok: true }, 201);
});

route("POST", "self/links/:id/revoke", (ctx, [linkId]) => {
  revokeLink(ctx.db, userOf(ctx), linkId);
  return json({ ok: true });
});

route("DELETE", "self/links/:id", (ctx, [linkId]) => {
  deleteLink(ctx.db, userOf(ctx), linkId);
  return json({ ok: true });
});

route("GET", "self/links", (ctx) => json({ links: listLinks(ctx.db, userOf(ctx)) }));

route("GET", "self/pending", (ctx) => json({ questions: pendingFor(ctx.db, { kind: "vault", userId: userOf(ctx) }) }));

route("POST", "self/questions/:id/answer", async (ctx, [questionId]) => {
  const userId = userOf(ctx);
  answerQuestion(ctx.db, { kind: "vault", userId }, questionId, parse(answerShape, await readJson(ctx.req, 200 * KB)));
  return json({ ok: true });
});

// ---- the public side of a link: anyone holding it; the server only relays boxes

route("GET", "ask/:id", (ctx, [linkId]) => {
  rateLimit(`ask-read:${clientIp(ctx.req)}`, 120, 60_000);
  return json(publicLink(ctx.db, linkId));
});

route("POST", "ask/:id/questions", async (ctx, [linkId]) => {
  rateLimit(`ask:${clientIp(ctx.req)}`, 8, 60_000);
  rateLimit(`ask-hour:${clientIp(ctx.req)}`, 60, 3600_000);
  const body = parse(z.object({ id, sessionId: id, askerKey: boxPublicKey, sealed: relay(64 * KB) }), await readJson(ctx.req, 80 * KB));
  return json(askQuestion(ctx.db, linkId, body), 201);
});

route("GET", "ask/:id/questions/:qid", (ctx, [linkId, questionId]) => {
  rateLimit(`ask-poll:${clientIp(ctx.req)}`, 240, 60_000);
  return json(questionStatus(ctx.db, linkId, questionId));
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

// ---- connected apps: reads, and suggestions when the owner allows them

route("GET", "connector/v1/folders", (ctx) => {
  const auth = appOf(ctx);
  // An agent that may remember but not recall still gets the folders it may write: it needs their keys to write.
  const agent = agentOf(ctx.db, auth.appId);
  if (agent && !agent.rules.recall && !agent.rules.remember) assertTool(ctx.db, auth, "recall");
  const folders = appFolders(ctx.db, auth).filter((f) => !agent || agent.rules.recall || f.mode === "write");
  logRead(ctx.db, auth, "folders", null, folders.length);
  return json({ appId: auth.appId, folders });
});

route("GET", "connector/v1/index", (ctx) => {
  const auth = appOf(ctx);
  assertTool(ctx.db, auth, "recall");
  const folders = appFolders(ctx.db, auth);
  const memories = appIndex(ctx.db, auth);
  logRead(ctx.db, auth, "index", null, memories.length);
  return json({ appId: auth.appId, folders, memories });
});

route("POST", "connector/v1/read", async (ctx) => {
  const auth = appOf(ctx);
  assertTool(ctx.db, auth, "recall");
  const body = parse(z.object({ ids: z.array(id).min(1).max(20) }), await readJson(ctx.req, 16 * KB));
  const unique = [...new Set(body.ids)];
  const { found, missing } = appRead(ctx.db, auth, unique);
  for (const m of found) logRead(ctx.db, auth, "read", m.id, 1);
  const folders = appFolders(ctx.db, auth).filter((f) => found.some((m) => m.folderId === f.id));
  return json({ appId: auth.appId, folders, memories: found, missing });
});

// The vault public key and the tag that lets the app check it. Not a read of any memory, so not logged.
route("GET", "connector/v1/inbox", (ctx) => {
  const auth = appOf(ctx);
  return json({ appId: auth.appId, ...appInbox(ctx.db, auth) });
});

route("POST", "connector/v1/proposals", async (ctx) => {
  const auth = appOf(ctx);
  rateLimit(`propose:${auth.appId}`, 10, 60_000);
  const body = parse(z.object({ id, sealed: sealed(600 * KB) }), await readJson(ctx.req, 700 * KB));
  const p = createProposal(ctx.db, auth, body.id, body.sealed);
  return json({ appId: auth.appId, id: p.id, createdAt: p.createdAt }, 201);
});

// The AI self on the owner's machine: its encrypted config, and the questions for the links it answers.
route("GET", "connector/v1/self", (ctx) => {
  const auth = appOf(ctx);
  return json({ appId: auth.appId, ...selfForApp(ctx.db, auth) });
});

route("GET", "connector/v1/self/pending", (ctx) => {
  const auth = appOf(ctx);
  selfForApp(ctx.db, auth);
  return json({ appId: auth.appId, questions: pendingFor(ctx.db, { kind: "app", auth }) });
});

route("POST", "connector/v1/self/questions/:id/answer", async (ctx, [questionId]) => {
  const auth = appOf(ctx);
  answerQuestion(ctx.db, { kind: "app", auth }, questionId, parse(answerShape, await readJson(ctx.req, 200 * KB)));
  return json({ ok: true });
});

route("POST", "connector/v1/self/asked", async (ctx) => {
  const auth = appOf(ctx);
  rateLimit(`self-asked:${auth.appId}`, 30, 60_000);
  const body = parse(z.object({ id, note: sealed(128 * KB), cited: z.number().int().min(0).max(50) }), await readJson(ctx.req, 160 * KB));
  logSelfAnswer(ctx.db, auth, body.id, body.note, body.cited);
  return json({ ok: true }, 201);
});

// ---- legacy: the owner's plan

route("PUT", "legacy", async (ctx) => {
  const userId = userOf(ctx);
  savePlan(ctx.db, userId, parse(planShape, await readJson(ctx.req, 4 * MB)));
  return json(ownerPlan(ctx.db, userId));
});

route("DELETE", "legacy", (ctx) => {
  cancelPlan(ctx.db, userOf(ctx));
  return json({ ok: true });
});

route("POST", "legacy/check-in", (ctx) => {
  const userId = userOf(ctx);
  checkIn(ctx.db, userId);
  return json(ownerPlan(ctx.db, userId));
});

route("POST", "legacy/dismiss", (ctx) => {
  dismissMissed(ctx.db, userOf(ctx));
  return json({ ok: true });
});

// ---- legacy: invites and trusted people

route("GET", "legacy/invites/:id", (ctx, [personId]) => {
  userOf(ctx);
  return json(inviteFor(ctx.db, personId));
});

route("POST", "legacy/invites/:id", async (ctx, [personId]) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ publicKey: boxPublicKey, tag: hexTag }), await readJson(ctx.req, 4 * KB));
  answerInvite(ctx.db, userId, personId, body.publicKey, body.tag);
  return json({ ok: true });
});

route("GET", "legacy/trusted", (ctx) => json({ plans: trustedPlans(ctx.db, userOf(ctx)) }));

route("POST", "legacy/plans/:id/request", (ctx, [planId]) => {
  requestRelease(ctx.db, userOf(ctx), planId);
  return json({ ok: true });
});

route("POST", "legacy/plans/:id/pass", async (ctx, [planId]) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ to: id, sealed: sealed(4096) }), await readJson(ctx.req, 16 * KB));
  passShare(ctx.db, userId, planId, body.to, body.sealed);
  return json({ ok: true });
});

route("GET", "legacy/plans/:id/bundle", (ctx, [planId]) => json(bundleFor(ctx.db, userOf(ctx), planId)));

route("POST", "legacy/plans/:id/opened", async (ctx, [planId]) => {
  const userId = userOf(ctx);
  markOpened(ctx.db, userId, planId, parse(z.object({ kept: envelope(512 * KB) }), await readJson(ctx.req, 600 * KB)).kept);
  return json({ ok: true });
});

route("GET", "legacy/plans/:id/folders", (ctx, [planId]) => json(releasedFolders(ctx.db, userOf(ctx), planId)));

route("POST", "legacy/plans/:id/asked", async (ctx, [planId]) => {
  const userId = userOf(ctx);
  rateLimit(`legacy-ask:${userId}`, 30, 60_000);
  const body = parse(z.object({ id, note: sealed(128 * KB), cited: z.number().int().min(0).max(50) }), await readJson(ctx.req, 160 * KB));
  logLegacyAsk(ctx.db, userId, planId, body.id, body.note, body.cited);
  return json({ ok: true }, 201);
});

// ---- devices: the new device opens a pairing and picks up its sealed keys; the signed-in device sends them

route("POST", "devices/pairings", async (ctx) => {
  rateLimit(`pair:${clientIp(ctx.req)}`, 20, 60_000);
  const body = parse(z.object({ id, publicKey: boxPublicKey, code: pairingCodeShape, pollSecret: token }), await readJson(ctx.req, 4 * KB));
  return json(openPairing(ctx.db, body), 201);
});

route("POST", "devices/pairings/:id/poll", async (ctx, [pairingId]) => {
  rateLimit(`pair-poll:${clientIp(ctx.req)}`, 120, 60_000);
  const body = parse(z.object({ pollSecret: token }), await readJson(ctx.req, 4 * KB));
  return json(pickUp(ctx.db, pairingId, body.pollSecret));
});

route("GET", "devices/pairings", (ctx) => {
  userOf(ctx);
  rateLimit(`pair-find:${clientIp(ctx.req)}`, 30, 60_000);
  return json(findPairing(ctx.db, parse(pairingCodeShape, ctx.url.searchParams.get("code") ?? "")));
});

route("GET", "devices/pairings/:id", (ctx, [pairingId]) => {
  userOf(ctx);
  return json(pairingById(ctx.db, pairingId));
});

route("POST", "devices/pairings/:id/send", async (ctx, [pairingId]) => {
  const userId = userOf(ctx);
  const body = parse(
    z.object({ sealed: sealed(4096), deviceId: id, authToken: token, wrappedKey: envelope(256), note: envelope(1024) }),
    await readJson(ctx.req, 16 * KB),
  );
  sendToDevice(ctx.db, userId, pairingId, body.sealed, { kind: "device", ref: body.deviceId, authToken: body.authToken, wrappedKey: body.wrappedKey, note: body.note });
  return json({ keyslots: listKeyslots(ctx.db, userId) });
});

route("DELETE", "devices/:id", (ctx, [keyslotId]) => {
  const userId = userOf(ctx);
  revokeDevice(ctx.db, userId, keyslotId);
  return json({ keyslots: listKeyslots(ctx.db, userId) });
});

// ---- quick capture: sealed on the phone to the vault public key, into the inbox, without opening the vault

route("GET", "capture/key", (ctx) => {
  const userId = userOf(ctx);
  const key = getBoxKey(ctx.db, userId);
  if (!key) throw new HttpError(409, "Open your vault once on this device first.", "no_box");
  return json({ publicKey: key.publicKey });
});

route("POST", "capture", async (ctx) => {
  const userId = userOf(ctx);
  rateLimit(`capture:${userId}`, 30, 60_000);
  const body = parse(z.object({ id, sealed: sealed(3 * MB) }), await readJson(ctx.req, 4 * MB));
  return json(createCapture(ctx.db, userId, body.id, body.sealed), 201);
});

// ---- agents

route("POST", "agents", async (ctx) => {
  const userId = userOf(ctx);
  const body = parse(
    z.object({
      app: z.object({ id, meta: envelope(4096), secret: envelope(256), tokenHash: z.string().regex(/^[0-9a-f]{64}$/), grants: z.array(modeGrant).min(1).max(200) }),
      folder: folderShape,
      rules: agentRulesShape,
      publicKey: boxPublicKey,
    }),
    await readJson(ctx.req, 64 * KB),
  );
  createAgent(ctx.db, userId, body);
  return json({ ok: true }, 201);
});

route("PUT", "agents/:id", async (ctx, [appId]) => {
  const userId = userOf(ctx);
  updateAgent(ctx.db, userId, appId, parse(z.object({ rules: agentRulesShape, grants: z.array(modeGrant).min(1).max(200) }), await readJson(ctx.req, 64 * KB)));
  return json({ ok: true });
});

route("GET", "agents/:id/handoffs", (ctx, [appId]) => json({ handoffs: ownerHandoffs(ctx.db, userOf(ctx), appId) }));

// ---- team spaces

route("POST", "spaces", async (ctx) => {
  const userId = userOf(ctx);
  createSpace(ctx.db, userId, parse(z.object({ id, meta: envelope(4096), member: memberShape }), await readJson(ctx.req, 16 * KB)));
  return json({ ok: true }, 201);
});

route("POST", "spaces/:id/members", async (ctx, [spaceId]) => {
  const userId = userOf(ctx);
  addMember(ctx.db, userId, spaceId, parse(memberShape, await readJson(ctx.req, 16 * KB)));
  return json({ ok: true }, 201);
});

route("POST", "spaces/:id/accept", (ctx, [spaceId]) => {
  acceptSpace(ctx.db, userOf(ctx), spaceId);
  return json({ ok: true });
});

route("PUT", "spaces/:id/members/:mid/role", async (ctx, [spaceId, memberId]) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ role: spaceRole, tag: hexTag }), await readJson(ctx.req, 4 * KB));
  setRole(ctx.db, userId, spaceId, memberId, body.role as "read" | "write" | "admin", body.tag);
  return json({ ok: true });
});

route("POST", "spaces/:id/rotate", async (ctx, [spaceId]) => {
  const userId = userOf(ctx);
  const body = parse(
    z.object({
      epoch: z.number().int().min(2),
      meta: envelope(4096),
      memories: z.array(spaceMemoryShape).max(5000),
      members: z.array(z.object({ id, sealedKey: sealed(1024), tag: hexTag, label: envelope(1024) })).max(50),
      remove: z.array(id).min(1).max(50),
    }),
    await readJson(ctx.req, 64 * MB),
  );
  rotateSpace(ctx.db, userId, spaceId, body);
  return json({ ok: true });
});

route("DELETE", "spaces/:id", (ctx, [spaceId]) => {
  deleteSpace(ctx.db, userOf(ctx), spaceId);
  return json({ ok: true });
});

route("PUT", "spaces/:id/memories", async (ctx, [spaceId]) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ memories: z.array(spaceMemoryShape).min(1).max(200) }), await readJson(ctx.req, 24 * MB));
  return json({ saved: putSpaceMemories(ctx.db, { kind: "vault", userId }, spaceId, body.memories) });
});

route("POST", "spaces/:id/memories/delete", async (ctx, [spaceId]) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ ids: z.array(id).min(1).max(1000) }), await readJson(ctx.req, 128 * KB));
  return json({ deleted: deleteSpaceMemories(ctx.db, { kind: "vault", userId }, spaceId, body.ids) });
});

// ---- proof of a real life

route("GET", "presence", (ctx) => json(presenceTask(ctx.db, userOf(ctx), siteOrigin(ctx.req))));

route("POST", "presence", async (ctx) => {
  const userId = userOf(ctx);
  rateLimit(`presence:${userId}`, 20, 60_000);
  const body = parse(z.object({ hour: z.number().int().min(0), sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }), await readJson(ctx.req, 4 * KB));
  return json(recordPresence(ctx.db, userId, siteOrigin(ctx.req), body.hour, body.sig));
});

route("GET", "proof/presence", (ctx) => {
  const userId = userOf(ctx);
  return json({ origin: siteOrigin(ctx.req), periodSeconds: serverConfig.sealSeconds, hours: presenceProofs(ctx.db, userId) });
});

route("POST", "certificates", async (ctx) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ id, certificate: z.string().max(MAX_CERT_BYTES) }), await readJson(ctx.req, MAX_CERT_BYTES + 4 * KB));
  return json(publishCertificate(ctx.db, userId, body.id, body.certificate), 201);
});

route("DELETE", "certificates/:id", (ctx, [certId]) => {
  deleteCertificate(ctx.db, userOf(ctx), certId);
  return json({ ok: true });
});

// ---- agents through the connector: their own memory, handoff notes and team spaces

route("GET", "connector/v1/agent", (ctx) => {
  const auth = appOf(ctx);
  return json(agentProfile(ctx.db, auth));
});

route("POST", "connector/v1/remember", async (ctx) => {
  const auth = appOf(ctx);
  const body = parse(z.object({ memories: z.array(z.object({ id, folderId: id, head: envelope(64_000), body: envelope(3_000_000) })).min(1).max(20) }), await readJson(ctx.req, 8 * MB));
  return json({ appId: auth.appId, saved: agentRemember(ctx.db, auth, body.memories) }, 201);
});

route("POST", "connector/v1/forget", async (ctx) => {
  const auth = appOf(ctx);
  const body = parse(z.object({ ids: z.array(id).min(1).max(50) }), await readJson(ctx.req, 16 * KB));
  return json({ appId: auth.appId, ...agentForget(ctx.db, auth, body.ids) });
});

route("GET", "connector/v1/handoffs", (ctx) => {
  const auth = appOf(ctx);
  return json({ appId: auth.appId, handoffs: pendingHandoffs(ctx.db, auth, agentSpaceIds(ctx.db, auth.appId)) });
});

route("POST", "connector/v1/handoffs", async (ctx) => {
  const auth = appOf(ctx);
  rateLimit(`handoff:${auth.appId}`, 30, 60_000);
  const body = parse(z.object({ id, sealed: envelope(64 * KB), spaceId: id.nullable().optional() }), await readJson(ctx.req, 80 * KB));
  leaveHandoff(ctx.db, auth, { id: body.id, sealed: body.sealed, spaceId: body.spaceId ?? null }, (spaceId) => !!memberFor(ctx.db, spaceId, { kind: "agent", auth }));
  return json({ appId: auth.appId, id: body.id }, 201);
});

route("POST", "connector/v1/handoffs/picked", async (ctx) => {
  const auth = appOf(ctx);
  assertTool(ctx.db, auth, "handoff");
  pickHandoffs(ctx.db, auth, parse(z.object({ ids: z.array(id).min(1).max(100) }), await readJson(ctx.req, 16 * KB)).ids);
  return json({ ok: true });
});

route("GET", "connector/v1/spaces", (ctx) => {
  const auth = appOf(ctx);
  assertTool(ctx.db, auth, "recall");
  return json({ appId: auth.appId, spaces: agentSpaces(ctx.db, auth) });
});

route("POST", "connector/v1/spaces/:id/memories", async (ctx, [spaceId]) => {
  const auth = appOf(ctx);
  assertTool(ctx.db, auth, "remember");
  const body = parse(z.object({ memories: z.array(spaceMemoryShape).min(1).max(20) }), await readJson(ctx.req, 8 * MB));
  return json({ appId: auth.appId, saved: putSpaceMemories(ctx.db, { kind: "agent", auth }, spaceId, body.memories) }, 201);
});

route("POST", "connector/v1/spaces/:id/forget", async (ctx, [spaceId]) => {
  const auth = appOf(ctx);
  assertTool(ctx.db, auth, "forget");
  const body = parse(z.object({ ids: z.array(id).min(1).max(50) }), await readJson(ctx.req, 16 * KB));
  return json({ appId: auth.appId, deleted: deleteSpaceMemories(ctx.db, { kind: "agent", auth }, spaceId, body.ids) });
});

// ---------------------------------------------------------------- dispatch

// Apps that run in a web page (Sign in with Sigil) call the connector routes from
// their own origin. These routes take a bearer token and never a cookie, so any
// origin may call them; what a token can do is set by the vault owner.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600",
};

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
}

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
  if (path[0] === "connector") {
    if (ctx.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    return withCors(await dispatch(ctx));
  }
  return dispatch(ctx);
}

async function dispatch(ctx: Ctx): Promise<Response> {
  const path = ctx.path;
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
