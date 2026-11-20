// The whole HTTP API in one router. app/api/[...path]/route.ts hands every
// request here, and the tests call it directly with plain Request objects.
//
// Two kinds of callers:
//   the vault page   -> session cookie, same-origin checked
//   a connected app  -> "Authorization: Bearer <app token>", reads and suggestions only, every call logged

import { z } from "zod";
import {
  isBoxPublicKey,
  isEnvelope,
  isHandle,
  isMeetBox,
  isRelayBox,
  isSealed,
  isSettingName,
  isSigningKey,
  isSpaceKind,
  isSpaceRole,
  parseBundle,
  PUBLIC_MAX_PER_VISITOR,
  randomId,
  CAPTURE_PER_MINUTE,
  CAPTURE_TEXT_LIMIT,
  MOVE_MAX_DAYS,
  type VaultBundle,
} from "@sigil/core";
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
import { answerRequest, gateRead, listRequests, requestAccess, setProtected, takeApproval, useApproval } from "./protect";
import { addSource, appSources, listSources, pauseSource, removeSource, saveAppSource, saveSource, setSourceApp, syncDelete, syncWrite } from "./sync";
import {
  answerPublic,
  appPublicSelf,
  askPublic,
  deletePublicSelf,
  hideAnswer,
  ownerItems,
  ownerPublicSelf,
  publicItem,
  publicPage,
  publicPending,
  publicQuestionStatus,
  publishItems,
  savePublicSelf,
  visitorOf,
} from "./public";
import { acceptMeet, addTurn, declineMeet, invite, listMeets, meetsWaiting, removeMeet, stopMeet } from "./meets";
import { getIdentity, publicStatement, putStatement, setSelfKey, withdrawStatement } from "./identity";
import { createDraft, deleteDraft, listDrafts, logLesson, updateDraft } from "./work";
import { createDisclosure, deleteDisclosure, disclosureAnchor, listDisclosures, MAX_PROOF_BYTES, publishDisclosure, publishedDisclosure, spaceJoinEntry, unpublishDisclosure, updateDisclosureBox } from "./disclose";
import { cardOpens, openPublicCard, ownerCard, putCard, revokeCard } from "./emergency";
import { agreementSeal, declineAgreement, listAgreements, peerSigningKey, proposeAgreement, removeAgreement, signAgreementRow } from "./agreements";
import { deletePack, listPacks, logFollow, packVersions, publicPack, publishPack } from "./packs";
import { deleteCertificate, getCertificate, listCertificates, MAX_CERT_BYTES, MAX_CERT_HOURS, presenceCounts, presenceProofs, presenceTask, publishCertificate, recordPresence, rootsFor, setSignKey } from "./life";
import { bundleBody, importBundle } from "./bundles";
import { appBackup, backupAppIds, listRuns, recordAppRun, recordRun, setBackupApp } from "./backups";
import { assertNotMoved, cancelMove, fetchMove, fetchRemote, finishMove, health, notifyOldNode, recordArrival, remoteOrigin, sendMove, startMove, vaultNodes } from "./nodes";
import { captureByToken, captureInto, captureText, captureVaultKey, createCaptureKey, listCaptureKeys, revokeCaptureKey, type CaptureAuth } from "./captures";
import { askInSession, book, closeSession, ownerSessions, publicOffer, saveOffer, sessionQuestionStatus, sessionStatus } from "./sessions";
import { addHeir, leaveSpace, removeHeir } from "./spaces";

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
  voice: z.boolean().optional(),
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
const requesterShape = z.union([id, z.literal("self")]);
const publicItemShape = z.object({ id, title: z.string().max(300), body: z.string().max(20_000), tags: z.array(z.string().max(48)).max(32), editedAt: isoTime });
const wallShape = z.object({ question: z.string().max(2000), answer: z.string().max(4000), sources: z.array(z.object({ id, title: z.string().max(300) })).max(12) });
const meetBox = z.string().max(16 * 1024).refine(isMeetBox, "Expected a meet box");
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/, "Expected a 32-byte hash");
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Expected an address");
const edSignature = z.string().regex(/^[A-Za-z0-9_-]{86}$/, "Expected a signature");
const pairingCodeShape = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/, "Invalid code");
const sha256Shape = z.string().regex(/^[0-9a-f]{64}$/, "Expected a hash");
const bundleShape = z.custom<VaultBundle>((v) => {
  try {
    return !!parseBundle(JSON.stringify(v));
  } catch {
    return false;
  }
}, "Expected a Sigil vault bundle");
const signInShape = z.object({ kind: z.enum(["wallet", "phrase"]), ref: z.string().min(8).max(200), authToken: token });
const runShape = z.object({ id, hash: hex32Shape(), size: z.number().int().min(0).max(1e10), record: z.string().max(64 * 1024).refine(isSealed, "Expected a sealed box"), places: z.number().int().min(0).max(20) });
function hex32Shape() {
  return z.string().regex(/^0x[0-9a-f]{64}$/, "Expected a 32-byte hash");
}

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
  assertNotMoved(ctx.db, "vault", auth.userId);
  rateLimit(`app:${auth.appId}`, 240, 60_000);
  return auth;
}

/** A capture key's device: write-only into the inbox. */
function captureOf(ctx: Ctx): CaptureAuth {
  const header = ctx.req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9_-]{43})$/.exec(header.trim());
  rateLimit(`capture-ip:${clientIp(ctx.req)}`, 120, 60_000);
  const auth = m ? captureByToken(ctx.db, m[1]) : null;
  if (!auth) throw new HttpError(401, "This capture key was revoked or does not exist. Make a new one in your Sigil vault, under Devices.", "capture_revoked");
  assertNotMoved(ctx.db, "vault", auth.userId);
  rateLimit(`capture:${auth.id}`, CAPTURE_PER_MINUTE, 60_000);
  return auth;
}

/** The bearer of a session link. */
function sessionBearer(ctx: Ctx): string {
  const m = /^Bearer\s+([A-Za-z0-9_-]{43})$/.exec((ctx.req.headers.get("authorization") ?? "").trim());
  if (!m) throw new HttpError(401, "This session link is not complete. Open it again from where you saved it.", "no_session");
  return m[1];
}

function signedIn(ctx: Ctx, userId: string, body: Record<string, unknown>, keyslotId: string | null = null): Response {
  // A vault that moved to another node signs in there now.
  assertNotMoved(ctx.db, "vault", userId);
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

// A node's health, for a load balancer, a container's health check, or another node.
route("GET", "health", (ctx) => json(health(siteOrigin(ctx.req)), 200, { "access-control-allow-origin": "*" }));

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
    access: listRequests(ctx.db, userId),
    sync: listSources(ctx.db, userId),
    publicSelf: ownerPublicSelf(ctx.db, userId),
    meets: listMeets(ctx.db, userId),
    identity: getIdentity(ctx.db, userId),
    drafts: listDrafts(ctx.db, userId),
    disclosures: listDisclosures(ctx.db, userId),
    emergency: { card: ownerCard(ctx.db, userId), opens: cardOpens(ctx.db, userId) },
    agreements: listAgreements(ctx.db, userId),
    packs: listPacks(ctx.db, userId),
    captureKeys: listCaptureKeys(ctx.db, userId),
    backups: { runs: listRuns(ctx.db, userId), apps: [...backupAppIds(ctx.db, userId)] },
    nodes: vaultNodes(ctx.db, userId, siteOrigin(ctx.req)),
    sessions: ownerSessions(ctx.db, userId),
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
  // The self wallet's rules are part of its identity's history: each saved draft is a line in the log.
  if (name === "wallet") logRead(ctx.db, { appId: "self", userId }, "identity", "rules-saved", 1);
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
  assertNotMoved(ctx.db, "ask", linkId);
  return json(publicLink(ctx.db, linkId));
});

route("POST", "ask/:id/questions", async (ctx, [linkId]) => {
  rateLimit(`ask:${clientIp(ctx.req)}`, 8, 60_000);
  rateLimit(`ask-hour:${clientIp(ctx.req)}`, 60, 3600_000);
  assertNotMoved(ctx.db, "ask", linkId);
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
  const app = ctx.url.searchParams.get("app") ?? undefined;
  if (app !== undefined && !/^[A-Za-z0-9_-]{4,64}$/.test(app)) throw new HttpError(400, "Invalid app id.", "invalid");
  return json({ periodSeconds: serverConfig.sealSeconds, mode: anchorStatus().mode, entries: listLog(ctx.db, userId, limit, before, app) });
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

// The heads of every memory the app may read. Protected folders are left out;
// ?protected=<folder id> asks for that one too, which needs the owner's yes
// (a request waits in the inbox until then, and a yes is good for one look).
route("GET", "connector/v1/index", (ctx) => {
  const auth = appOf(ctx);
  assertTool(ctx.db, auth, "recall");
  const folders = appFolders(ctx.db, auth);
  const want = ctx.url.searchParams.get("protected");
  let open: string | null = null;
  const held: { folderId: string; requestId: string; state: string }[] = [];
  if (want) {
    if (!folders.some((f) => f.id === want && f.protected)) throw new HttpError(404, "This app may not read a protected folder with that id.", "not_protected");
    if (takeApproval(ctx.db, auth.userId, auth.appId, want, "index", [])) open = want;
    else {
      const req = requestAccess(ctx.db, auth.userId, { requester: auth.appId, requesterKind: "app", folderId: want, memoryIds: [], scope: "index" });
      held.push({ folderId: want, requestId: req.id, state: req.state });
    }
  }
  const memories = appIndex(ctx.db, auth, open);
  const inOpen = open ? memories.filter((m) => m.folderId === open).length : 0;
  logRead(ctx.db, auth, "index", null, memories.length - inOpen);
  if (open) logRead(ctx.db, auth, "protected", null, inOpen);
  return json({ appId: auth.appId, folders, memories, held });
});

route("POST", "connector/v1/read", async (ctx) => {
  const auth = appOf(ctx);
  assertTool(ctx.db, auth, "recall");
  const body = parse(z.object({ ids: z.array(id).min(1).max(20) }), await readJson(ctx.req, 16 * KB));
  const unique = [...new Set(body.ids)];
  const { found, missing } = appRead(ctx.db, auth, unique);
  // Memories in protected folders are handed over only with the owner's yes for this read.
  const { open, protectedRead, held } = gateRead(ctx.db, auth, found);
  for (const m of open) logRead(ctx.db, auth, "read", m.id, 1);
  for (const m of protectedRead) logRead(ctx.db, auth, "protected", m.id, 1);
  const memories = [...open, ...protectedRead];
  const folders = appFolders(ctx.db, auth).filter((f) => memories.some((m) => m.folderId === f.id));
  return json({ appId: auth.appId, folders, memories, missing, held });
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
  createSpace(
    ctx.db,
    userId,
    parse(z.object({ id, meta: envelope(4096), member: memberShape, kind: z.string().refine(isSpaceKind, "Expected team, family or history").optional() }), await readJson(ctx.req, 16 * KB)) as Parameters<typeof createSpace>[2],
  );
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
      heirs: z.array(z.object({ id, sealedKey: sealed(1024), tag: hexTag, label: envelope(1024) })).max(20).optional(),
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

// ---- protected folders: the owner's yes for each read

route("PUT", "folders/:id/protect", async (ctx, [folderId]) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ protected: z.boolean(), meta: envelope(4096) }), await readJson(ctx.req, 16 * KB));
  setProtected(ctx.db, userId, folderId, body.protected, body.meta);
  return json({ ok: true });
});

route("GET", "access", (ctx) => json({ requests: listRequests(ctx.db, userOf(ctx)) }));

// The owner's device asks too, when the AI self it runs (for a link, the public page or another self) needs a protected folder.
route("POST", "access", async (ctx) => {
  const userId = userOf(ctx);
  rateLimit(`access:${userId}`, 60, 60_000);
  const body = parse(
    z.object({
      id,
      requester: requesterShape,
      requesterKind: z.enum(["link", "public", "meet", "self"]),
      folderId: id,
      memoryIds: z.array(id).max(50),
      approve: z.boolean().optional(),
    }),
    await readJson(ctx.req, 16 * KB),
  );
  let req = requestAccess(ctx.db, userId, { id: body.id, requester: body.requester, requesterKind: body.requesterKind, folderId: body.folderId, memoryIds: body.memoryIds, scope: "read" });
  // A yes given on the vault screen itself, for the owner's own test chat.
  if (body.approve && req.state === "pending") req = answerRequest(ctx.db, userId, req.id, true);
  return json({ request: req }, 201);
});

route("POST", "access/:id/approve", (ctx, [requestId]) => json({ request: answerRequest(ctx.db, userOf(ctx), requestId, true) }));
route("POST", "access/:id/deny", (ctx, [requestId]) => json({ request: answerRequest(ctx.db, userOf(ctx), requestId, false) }));

route("POST", "access/:id/use", async (ctx, [requestId]) => {
  const userId = userOf(ctx);
  useApproval(ctx.db, userId, requestId, parse(z.object({ memoryIds: z.array(id).min(1).max(50) }), await readJson(ctx.req, 16 * KB)).memoryIds);
  return json({ ok: true });
});

// ---- live sync: sources under the vault key; fetching and encrypting happen on the device

route("GET", "sync/config", () => json({ clients: serverConfig.syncClients }));

route("GET", "sync", (ctx) => json({ sources: listSources(ctx.db, userOf(ctx)) }));

route("POST", "sync", async (ctx) => {
  const userId = userOf(ctx);
  addSource(ctx.db, userId, parse(z.object({ id, folderId: id, ownerBox: envelope(256 * KB), rev: z.number().int().min(0) }), await readJson(ctx.req, 300 * KB)));
  return json({ ok: true }, 201);
});

route("PUT", "sync/:id", async (ctx, [sourceId]) => {
  const userId = userOf(ctx);
  const body = parse(
    z.object({ ownerBox: envelope(256 * KB), rev: z.number().int().min(0), appBox: envelope(256 * KB).nullable().optional(), appRev: z.number().int().min(0).optional(), synced: z.boolean().optional() }),
    await readJson(ctx.req, 600 * KB),
  );
  return json({ source: saveSource(ctx.db, userId, sourceId, body) });
});

route("POST", "sync/:id/pause", async (ctx, [sourceId]) => {
  const userId = userOf(ctx);
  pauseSource(ctx.db, userId, sourceId, parse(z.object({ paused: z.boolean() }), await readJson(ctx.req, 4 * KB)).paused);
  return json({ ok: true });
});

route("DELETE", "sync/:id", (ctx, [sourceId]) => {
  removeSource(ctx.db, userOf(ctx), sourceId);
  return json({ ok: true });
});

route("PUT", "sync/:id/app", async (ctx, [sourceId]) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ appId: id, appBox: envelope(256 * KB), appRev: z.number().int().min(0), wrappedKey: envelope(256) }), await readJson(ctx.req, 300 * KB));
  setSourceApp(ctx.db, userId, sourceId, body);
  return json({ ok: true });
});

route("DELETE", "sync/:id/app", (ctx, [sourceId]) => {
  setSourceApp(ctx.db, userOf(ctx), sourceId, null);
  return json({ ok: true });
});

route("GET", "connector/v1/sync", (ctx) => {
  const auth = appOf(ctx);
  return json({ appId: auth.appId, sources: appSources(ctx.db, auth) });
});

route("PUT", "connector/v1/sync/:id", async (ctx, [sourceId]) => {
  const auth = appOf(ctx);
  const body = parse(z.object({ box: envelope(256 * KB), rev: z.number().int().min(0) }), await readJson(ctx.req, 300 * KB));
  saveAppSource(ctx.db, auth, sourceId, body.box, body.rev);
  return json({ ok: true });
});

route("POST", "connector/v1/sync/:id/memories", async (ctx, [sourceId]) => {
  const auth = appOf(ctx);
  const body = parse(z.object({ memories: z.array(z.object({ id, folderId: id, head: envelope(64_000), body: envelope(3_000_000) })).min(1).max(100) }), await readJson(ctx.req, 24 * MB));
  return json({ appId: auth.appId, saved: syncWrite(ctx.db, auth, sourceId, body.memories) }, 201);
});

route("POST", "connector/v1/sync/:id/delete", async (ctx, [sourceId]) => {
  const auth = appOf(ctx);
  const body = parse(z.object({ ids: z.array(id).min(1).max(500) }), await readJson(ctx.req, 64 * KB));
  return json({ appId: auth.appId, deleted: syncDelete(ctx.db, auth, sourceId, body.ids) });
});

// ---- the public AI self: the owner's settings and public copy

const publicShape = z.object({
  id,
  handle: z.string().refine(isHandle, "Expected a handle of 3 to 30 lowercase letters, digits, - or _"),
  name: z.string().trim().min(1).max(80),
  greeting: z.string().max(400),
  publicKey: boxPublicKey,
  ownerBox: envelope(128 * KB),
  appId: id.nullable(),
  appBox: envelope(128 * KB).nullable(),
  perVisitorHour: z.number().int().min(1).max(PUBLIC_MAX_PER_VISITOR),
  showAnswers: z.boolean(),
  enabled: z.boolean(),
  voice: z.boolean().optional(),
});

route("GET", "public/self", (ctx) => {
  const userId = userOf(ctx);
  return json({ self: ownerPublicSelf(ctx.db, userId), items: ownerItems(ctx.db, userId) });
});

route("PUT", "public/self", async (ctx) => {
  const userId = userOf(ctx);
  savePublicSelf(ctx.db, userId, parse(publicShape, await readJson(ctx.req, 300 * KB)));
  return json({ self: ownerPublicSelf(ctx.db, userId) });
});

route("DELETE", "public/self", (ctx) => {
  deletePublicSelf(ctx.db, userOf(ctx));
  return json({ ok: true });
});

route("PUT", "public/self/items", async (ctx) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ items: z.array(publicItemShape).max(2000), hash: z.string().regex(/^[0-9a-f]{64}$/) }), await readJson(ctx.req, 10 * MB));
  return json({ published: publishItems(ctx.db, userId, body.items, body.hash) });
});

route("POST", "public/wall/:id/hide", async (ctx, [answerId]) => {
  const userId = userOf(ctx);
  hideAnswer(ctx.db, userId, answerId, parse(z.object({ hidden: z.boolean() }), await readJson(ctx.req, 4 * KB)).hidden);
  return json({ ok: true });
});

route("GET", "public/pending", (ctx) => json({ questions: publicPending(ctx.db, { kind: "vault", userId: userOf(ctx) }) }));

const publicAnswerShape = z.object({ sealed: relay(64 * KB), note: sealed(128 * KB), cited: z.number().int().min(0).max(50), wall: wallShape.nullable() });

route("POST", "public/questions/:id/answer", async (ctx, [questionId]) => {
  const userId = userOf(ctx);
  answerPublic(ctx.db, { kind: "vault", userId }, questionId, parse(publicAnswerShape, await readJson(ctx.req, 200 * KB)));
  return json({ ok: true });
});

route("GET", "connector/v1/public", (ctx) => {
  const auth = appOf(ctx);
  return json({ appId: auth.appId, self: appPublicSelf(ctx.db, auth) });
});

route("GET", "connector/v1/public/pending", (ctx) => {
  const auth = appOf(ctx);
  return json({ appId: auth.appId, questions: publicPending(ctx.db, { kind: "app", auth }) });
});

route("POST", "connector/v1/public/questions/:id/answer", async (ctx, [questionId]) => {
  const auth = appOf(ctx);
  answerPublic(ctx.db, { kind: "app", auth }, questionId, parse(publicAnswerShape, await readJson(ctx.req, 200 * KB)));
  return json({ ok: true });
});

// ---- the public page at /@handle: anyone may read it and ask; the server relays boxes

route("GET", "public/at/:handle", (ctx, [handle]) => {
  rateLimit(`public-read:${clientIp(ctx.req)}`, 120, 60_000);
  return json(publicPage(ctx.db, handle.toLowerCase()));
});

route("GET", "public/at/:handle/items/:id", (ctx, [handle, itemId]) => {
  rateLimit(`public-read:${clientIp(ctx.req)}`, 120, 60_000);
  return json(publicItem(ctx.db, handle.toLowerCase(), itemId));
});

route("POST", "public/at/:handle/questions", async (ctx, [handle]) => {
  const ip = clientIp(ctx.req);
  rateLimit(`public-ask:${ip}`, 8, 60_000);
  const page = publicPage(ctx.db, handle.toLowerCase());
  const body = parse(z.object({ id, sessionId: id, askerKey: boxPublicKey, sealed: relay(64 * KB) }), await readJson(ctx.req, 80 * KB));
  return json(askPublic(ctx.db, page.handle, visitorOf(ip, page.id), body), 201);
});

route("GET", "public/at/:handle/questions/:qid", (ctx, [handle, questionId]) => {
  rateLimit(`public-poll:${clientIp(ctx.req)}`, 240, 60_000);
  return json(publicQuestionStatus(ctx.db, handle.toLowerCase(), questionId));
});

// ---- selves meet selves: invites, answers and turns, all boxes the server cannot open

route("GET", "meets", (ctx) => json({ meets: listMeets(ctx.db, userOf(ctx)) }));

route("POST", "meets", async (ctx) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ id, toKey: boxPublicKey, invite: sealed(8 * KB), box: envelope(64 * KB), turnLimit: z.number().int().min(2).max(12) }), await readJson(ctx.req, 100 * KB));
  return json({ meet: invite(ctx.db, userId, body) }, 201);
});

route("POST", "meets/:id/accept", async (ctx, [meetId]) => {
  const userId = userOf(ctx);
  return json({ meet: acceptMeet(ctx.db, userId, meetId, parse(z.object({ answer: sealed(8 * KB), box: envelope(64 * KB) }), await readJson(ctx.req, 100 * KB))) });
});

route("POST", "meets/:id/decline", (ctx, [meetId]) => {
  declineMeet(ctx.db, userOf(ctx), meetId);
  return json({ ok: true });
});

route("POST", "meets/:id/stop", (ctx, [meetId]) => {
  stopMeet(ctx.db, userOf(ctx), meetId);
  return json({ ok: true });
});

route("DELETE", "meets/:id", (ctx, [meetId]) => {
  removeMeet(ctx.db, userOf(ctx), meetId);
  return json({ ok: true });
});

route("GET", "meets/waiting", (ctx) => json({ meets: meetsWaiting(ctx.db, userOf(ctx)) }));

route("POST", "meets/:id/turns", async (ctx, [meetId]) => {
  const userId = userOf(ctx);
  rateLimit(`meet-turn:${userId}`, 30, 60_000);
  const body = parse(z.object({ turn: z.number().int().min(1).max(12), box: meetBox, done: z.boolean(), cited: z.number().int().min(0).max(50) }), await readJson(ctx.req, 32 * KB));
  return json({ meet: addTurn(ctx.db, userId, meetId, body) }, 201);
});

// ---- the AI self's identity: its self key, a signed statement, and where the registry is

route("GET", "identity/config", () => json({ chain: serverConfig.identityChain }));

// The public statement of a self key: what the registry's metadata address points at.
route("GET", "identity/at/:address", (ctx, [address]) => {
  rateLimit(`public:${clientIp(ctx.req)}`, 240, 60_000);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new HttpError(400, "That is not an address.", "invalid");
  return new Response(publicStatement(ctx.db, address), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" } });
});

route("POST", "self/identity", async (ctx) => {
  const userId = userOf(ctx);
  return json({ identity: setSelfKey(ctx.db, userId, parse(z.object({ address: evmAddress }), await readJson(ctx.req, 4 * KB)).address) }, 201);
});

route("PUT", "self/identity/statement", async (ctx) => {
  const userId = userOf(ctx);
  return json({ identity: putStatement(ctx.db, userId, parse(z.object({ statement: z.string().max(16 * KB) }), await readJson(ctx.req, 20 * KB)).statement) });
});

route("DELETE", "self/identity/statement", (ctx) => {
  withdrawStatement(ctx.db, userOf(ctx));
  return json({ ok: true });
});

// ---- the AI self at work: drafts waiting for the owner, each sealed under the vault key

route("GET", "drafts", (ctx) => json({ drafts: listDrafts(ctx.db, userOf(ctx)) }));

route("POST", "drafts", async (ctx) => {
  const userId = userOf(ctx);
  rateLimit(`drafts:${userId}`, 60, 60_000);
  const body = parse(z.object({ id, kind: z.enum(["reply", "plan", "answer"]), ref: z.string().regex(/^[A-Za-z0-9_:-]{4,140}$/).nullable(), box: envelope(160 * KB) }), await readJson(ctx.req, 200 * KB));
  return json({ draft: createDraft(ctx.db, userId, body) }, 201);
});

route("PUT", "drafts/:id", async (ctx, [draftId]) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ box: envelope(160 * KB), state: z.enum(["waiting", "approved", "discarded"]).optional(), learned: z.boolean().optional() }), await readJson(ctx.req, 200 * KB));
  return json({ draft: updateDraft(ctx.db, userId, draftId, body) });
});

route("DELETE", "drafts/:id", (ctx, [draftId]) => {
  deleteDraft(ctx.db, userOf(ctx), draftId);
  return json({ ok: true });
});

route("POST", "work/lessons", async (ctx) => {
  const userId = userOf(ctx);
  logLesson(ctx.db, userId, parse(z.object({ step: z.enum(["lesson-edited", "lesson-deleted"]) }), await readJson(ctx.req, 1 * KB)).step);
  return json({ ok: true });
});

// ---- proofs of a fact: the statement's hash goes into the log; the proof is complete once its hour is sealed

route("POST", "disclosures", async (ctx) => {
  const userId = userOf(ctx);
  rateLimit(`disclose:${userId}`, 30, 60_000);
  const body = parse(z.object({ id, hash: hex32, box: envelope(MAX_PROOF_BYTES * 2) }), await readJson(ctx.req, MAX_PROOF_BYTES * 2 + 4 * KB));
  return json({ disclosure: createDisclosure(ctx.db, userId, body) }, 201);
});

route("PUT", "disclosures/:id", async (ctx, [disclosureId]) => {
  const userId = userOf(ctx);
  updateDisclosureBox(ctx.db, userId, disclosureId, parse(z.object({ box: envelope(MAX_PROOF_BYTES * 2) }), await readJson(ctx.req, MAX_PROOF_BYTES * 2 + 4 * KB)).box);
  return json({ ok: true });
});

route("GET", "disclosures/:id/anchor", (ctx, [disclosureId]) => json({ anchor: disclosureAnchor(ctx.db, userOf(ctx), disclosureId) }));

route("PUT", "disclosures/:id/publish", async (ctx, [disclosureId]) => {
  const userId = userOf(ctx);
  await publishDisclosure(ctx.db, userId, disclosureId, parse(z.object({ proof: z.string().max(MAX_PROOF_BYTES) }), await readJson(ctx.req, MAX_PROOF_BYTES + 4 * KB)).proof);
  return json({ ok: true });
});

route("DELETE", "disclosures/:id/publish", (ctx, [disclosureId]) => {
  unpublishDisclosure(ctx.db, userOf(ctx), disclosureId);
  return json({ ok: true });
});

route("DELETE", "disclosures/:id", (ctx, [disclosureId]) => {
  deleteDisclosure(ctx.db, userOf(ctx), disclosureId);
  return json({ ok: true });
});

// A shared proof, by its link. It holds the one claim and its evidence.
route("GET", "proofs/:id", (ctx, [proofId]) => {
  rateLimit(`public:${clientIp(ctx.req)}`, 240, 60_000);
  return new Response(publishedDisclosure(ctx.db, proofId), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
});

route("GET", "proof/space/:id", (ctx, [spaceId]) => json({ entry: spaceJoinEntry(ctx.db, userOf(ctx), spaceId) }));

// ---- the emergency card: ciphertext under a key the server never receives

route("PUT", "emergency", async (ctx) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ id, card: envelope(16 * KB), ownerBox: envelope(24 * KB) }), await readJson(ctx.req, 48 * KB));
  return json({ card: putCard(ctx.db, userId, body) });
});

route("DELETE", "emergency", (ctx) => {
  revokeCard(ctx.db, userOf(ctx));
  return json({ ok: true });
});

route("GET", "emergency/opens", (ctx) => json({ opens: cardOpens(ctx.db, userOf(ctx)) }));

// Anyone with the link: the card's ciphertext. Each opening is logged for the owner without anything that identifies the opener.
route("GET", "e/:id", (ctx, [cardId]) => {
  rateLimit(`emergency:${clientIp(ctx.req)}`, 60, 60_000);
  assertNotMoved(ctx.db, "emergency", cardId);
  return json(openPublicCard(ctx.db, cardId, ctx.req));
});

// ---- sealed agreements between two vaults

route("GET", "agreements", (ctx) => json({ agreements: listAgreements(ctx.db, userOf(ctx)) }));

route("GET", "agreements/peer/:key", (ctx, [key]) => {
  userOf(ctx);
  return json({ signingKey: peerSigningKey(ctx.db, parse(boxPublicKey, key)) });
});

route("POST", "agreements", async (ctx) => {
  const userId = userOf(ctx);
  const body = parse(
    z.object({
      id,
      toKey: boxPublicKey,
      hash: hex32,
      version: z.number().int().min(1).max(1000),
      previous: hex32.nullable(),
      offer: sealed(160 * KB),
      box: envelope(160 * KB),
      signature: edSignature,
    }),
    await readJson(ctx.req, 360 * KB),
  );
  return json({ agreement: proposeAgreement(ctx.db, userId, body) }, 201);
});

route("POST", "agreements/:id/sign", async (ctx, [agreementId]) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ signature: edSignature, box: envelope(160 * KB) }), await readJson(ctx.req, 180 * KB));
  return json({ agreement: signAgreementRow(ctx.db, userId, agreementId, body) });
});

route("POST", "agreements/:id/decline", (ctx, [agreementId]) => {
  declineAgreement(ctx.db, userOf(ctx), agreementId);
  return json({ ok: true });
});

route("DELETE", "agreements/:id", (ctx, [agreementId]) => {
  removeAgreement(ctx.db, userOf(ctx), agreementId);
  return json({ ok: true });
});

route("GET", "agreements/:id/seal", (ctx, [agreementId]) => json({ seal: agreementSeal(ctx.db, userOf(ctx), agreementId), periodSeconds: serverConfig.sealSeconds }));

// ---- knowledge packs: public and signed; followed from each follower's own vault

route("GET", "packs", (ctx) => json({ packs: listPacks(ctx.db, userOf(ctx)) }));

route("POST", "packs", async (ctx) => {
  const userId = userOf(ctx);
  rateLimit(`packs:${userId}`, 20, 60_000);
  const body = parse(z.object({ folderId: id, pack: z.string().max(2_200_000) }), await readJson(ctx.req, 2_300_000));
  return json({ pack: publishPack(ctx.db, userId, body) }, 201);
});

route("DELETE", "packs/:id", (ctx, [packId]) => {
  deletePack(ctx.db, userOf(ctx), packId);
  return json({ ok: true });
});

route("POST", "packs/:id/log", async (ctx, [packId]) => {
  const userId = userOf(ctx);
  const body = parse(z.object({ step: z.enum(["followed", "updated", "unfollowed"]), version: z.number().int().min(0).max(100_000), items: z.number().int().min(0).max(10_000) }), await readJson(ctx.req, 2 * KB));
  logFollow(ctx.db, userId, packId, body.step, body.version, body.items);
  return json({ ok: true });
});

// A pack, by its link: the latest version, or one by number. Public, like the pack itself.
route("GET", "packs/at/:id", (ctx, [packId]) => {
  rateLimit(`public:${clientIp(ctx.req)}`, 240, 60_000);
  assertNotMoved(ctx.db, "pack", packId);
  const v = ctx.url.searchParams.get("version");
  const version = v && /^\d{1,6}$/.test(v) ? Number(v) : undefined;
  return new Response(publicPack(ctx.db, packId, version), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" } });
});

route("GET", "packs/at/:id/versions", (ctx, [packId]) => {
  rateLimit(`public:${clientIp(ctx.req)}`, 240, 60_000);
  return json({ versions: packVersions(ctx.db, packId) });
});

// ---- shared memory: leaving it, and heirs

route("POST", "spaces/:id/leave", (ctx, [spaceId]) => {
  leaveSpace(ctx.db, userOf(ctx), spaceId);
  return json({ ok: true });
});

route("POST", "spaces/:id/heirs", async (ctx, [spaceId]) => {
  const userId = userOf(ctx);
  const body = parse(
    z.object({ id, publicKey: boxPublicKey, role: spaceRole, sealedKey: sealed(1024), tag: hexTag, label: envelope(1024), forMember: id.nullable() }),
    await readJson(ctx.req, 16 * KB),
  );
  addHeir(ctx.db, userId, spaceId, body as Parameters<typeof addHeir>[3]);
  return json({ ok: true }, 201);
});

route("DELETE", "spaces/:id/heirs/:hid", (ctx, [spaceId, heirId]) => {
  removeHeir(ctx.db, userOf(ctx), spaceId, heirId);
  return json({ ok: true });
});

// ---- the vault as one bundle, backups and restoring

// What this node keeps for the vault, for the owner's device to seal and store.
route("GET", "bundle", (ctx) => {
  const userId = userOf(ctx);
  rateLimit(`bundle:${userId}`, 20, 60_000);
  return json({ body: bundleBody(ctx.db, userId, siteOrigin(ctx.req), "vault") });
});

route("POST", "backups", async (ctx) => {
  const userId = userOf(ctx);
  recordRun(ctx.db, userId, parse(runShape, await readJson(ctx.req, 80 * KB)));
  return json({ runs: listRuns(ctx.db, userId) }, 201);
});

route("PUT", "apps/:id/backup", async (ctx, [appId]) => {
  const userId = userOf(ctx);
  setBackupApp(ctx.db, userId, appId, parse(z.object({ box: envelope(128 * KB) }), await readJson(ctx.req, 160 * KB)).box);
  return json({ ok: true });
});

route("DELETE", "apps/:id/backup", (ctx, [appId]) => {
  setBackupApp(ctx.db, userOf(ctx), appId, null);
  return json({ ok: true });
});

route("GET", "connector/v1/backup", (ctx) => {
  const auth = appOf(ctx);
  return json({ appId: auth.appId, ...appBackup(ctx.db, auth) });
});

route("GET", "connector/v1/backup/bundle", (ctx) => {
  const auth = appOf(ctx);
  appBackup(ctx.db, auth);
  rateLimit(`bundle:${auth.userId}`, 20, 60_000);
  return json({ appId: auth.appId, body: bundleBody(ctx.db, auth.userId, siteOrigin(ctx.req), "connector") });
});

route("POST", "connector/v1/backup/done", async (ctx) => {
  const auth = appOf(ctx);
  recordAppRun(ctx.db, auth, parse(runShape, await readJson(ctx.req, 80 * KB)));
  return json({ ok: true }, 201);
});

// A bundle from a public address (an IPFS or Arweave gateway, a presigned bucket address), fetched for a restore. Nothing is kept.
route("POST", "restore/fetch", async (ctx) => {
  rateLimit(`restore-fetch:${clientIp(ctx.req)}`, 10, 60_000);
  assertSameOrigin(ctx.req);
  const { url } = parse(z.object({ url: z.string().url().max(4000) }), await readJson(ctx.req, 8 * KB));
  // https only (http only on this machine), and never into a private network unless this node allows it.
  remoteOrigin(new URL(url).origin);
  const res = await fetchRemote(url);
  if (!res.ok) throw new HttpError(502, `That address answered ${res.status}.`, "fetch_failed");
  return new Response(new Uint8Array(await res.arrayBuffer()), { status: 200, headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
});

// Restoring a bundle as a new vault on this node, with the owner's sign-in and a statement signed for this node.
route("POST", "restore", async (ctx) => {
  rateLimit(`restore:${clientIp(ctx.req)}`, 10, 60_000);
  assertSameOrigin(ctx.req);
  const body = parse(
    z.object({
      bundle: bundleShape,
      signIn: signInShape,
      statement: z.object({ issuedAt: isoTime, signature: edSignature }),
      arrival: z.object({ code: z.string().max(400), at: isoTime, signature: edSignature, redirectDays: z.number().int().min(1).max(MOVE_MAX_DAYS) }).optional(),
    }),
    await readJson(ctx.req, 512 * MB),
  );
  const origin = siteOrigin(ctx.req);
  let arrival: { moveId: string; from: string; secret: string } | null = null;
  if (body.arrival) {
    // A restore that ends a move: the move must be the one the old node holds for this bundle.
    const fetched = await fetchMove(body.arrival.code, origin);
    if (fetched.bundle.hash !== body.bundle.hash) throw new HttpError(400, "This bundle is not the one the move names.", "bad_bundle");
    const parts = body.arrival.code.split(".");
    arrival = { moveId: fetched.move.statement.id, from: fetched.from, secret: parts[3] };
  }
  const report = importBundle(ctx.db, body.bundle, origin, body.signIn, body.statement);
  let nodeRow: string | null = null;
  if (arrival && body.arrival) {
    nodeRow = recordArrival(ctx.db, report.userId, { ...arrival, at: body.arrival.at, signature: body.arrival.signature }, body.arrival.redirectDays);
  }
  const sessionToken = createSession(ctx.db, report.userId, null);
  const confirmed = nodeRow ? await notifyOldNode(ctx.db, report.userId, nodeRow) : null;
  return json({ report, confirmed }, 201, { "set-cookie": sessionCookie(ctx.req, sessionToken, serverConfig.sessionDays * 86400) });
});

// ---- nodes: where the vault lives, and moving it

route("GET", "nodes", (ctx) => json(vaultNodes(ctx.db, userOf(ctx), siteOrigin(ctx.req))));

route("POST", "nodes/moves", async (ctx) => {
  const userId = userOf(ctx);
  rateLimit(`move:${userId}`, 10, 60_000);
  const body = parse(
    z.object({ move: z.object({ statement: z.record(z.string(), z.unknown()), signature: edSignature }), secretHash: sha256Shape, bundle: bundleShape }),
    await readJson(ctx.req, 512 * MB),
  );
  return json(startMove(ctx.db, userId, siteOrigin(ctx.req), body as unknown as Parameters<typeof startMove>[3]), 201);
});

route("DELETE", "nodes/moves/:id", (ctx, [moveId]) => {
  cancelMove(ctx.db, userOf(ctx), moveId);
  return json({ ok: true });
});

// The new node asks for the move with the secret from the move code.
route("GET", "nodes/moves/:id", (ctx, [moveId]) => {
  rateLimit(`move-fetch:${clientIp(ctx.req)}`, 30, 60_000);
  const m = /^Bearer\s+([A-Za-z0-9_-]{43})$/.exec((ctx.req.headers.get("authorization") ?? "").trim());
  if (!m) throw new HttpError(401, "This move needs its secret.", "no_secret");
  return json(sendMove(ctx.db, moveId, m[1]));
});

// The new node passes on the arrival the vault's key signed.
route("POST", "nodes/moves/:id/done", async (ctx, [moveId]) => {
  rateLimit(`move-done:${clientIp(ctx.req)}`, 30, 60_000);
  const m = /^Bearer\s+([A-Za-z0-9_-]{43})$/.exec((ctx.req.headers.get("authorization") ?? "").trim());
  if (!m) throw new HttpError(401, "This move needs its secret.", "no_secret");
  const body = parse(z.object({ at: isoTime, signature: edSignature }), await readJson(ctx.req, 4 * KB));
  return json(finishMove(ctx.db, moveId, m[1], body));
});

// The new node fetches a move from the old one, for the owner on the restore page.
route("POST", "nodes/arrive", async (ctx) => {
  rateLimit(`arrive:${clientIp(ctx.req)}`, 10, 60_000);
  assertSameOrigin(ctx.req);
  const { code } = parse(z.object({ code: z.string().max(400) }), await readJson(ctx.req, 4 * KB));
  const got = await fetchMove(code, siteOrigin(ctx.req));
  return json({ move: got.move, bundle: got.bundle });
});

route("POST", "nodes/:id/notify", async (ctx, [rowId]) => {
  const userId = userOf(ctx);
  return json({ confirmed: await notifyOldNode(ctx.db, userId, rowId) });
});

// ---- capture keys: made in the vault, used by a device or a shortcut

route("POST", "capture-keys", async (ctx) => {
  const userId = userOf(ctx);
  createCaptureKey(ctx.db, userId, parse(z.object({ id, tokenHash: sha256Shape, tag: hexTag, note: envelope(2048), plain: z.boolean() }), await readJson(ctx.req, 8 * KB)));
  return json({ captureKeys: listCaptureKeys(ctx.db, userId) }, 201);
});

route("DELETE", "capture-keys/:id", (ctx, [captureId]) => {
  const userId = userOf(ctx);
  revokeCaptureKey(ctx.db, userId, captureId);
  return json({ captureKeys: listCaptureKeys(ctx.db, userId) });
});

route("GET", "capture/v1/key", (ctx) => json(captureVaultKey(ctx.db, captureOf(ctx))));

route("POST", "capture/v1", async (ctx) => {
  const auth = captureOf(ctx);
  const body = parse(z.object({ id, sealed: sealed(3 * MB) }), await readJson(ctx.req, 4 * MB));
  return json(captureInto(ctx.db, auth, body.id, body.sealed), 201);
});

route("POST", "capture/v1/text", async (ctx) => {
  const auth = captureOf(ctx);
  const body = parse(z.object({ text: z.string().max(CAPTURE_TEXT_LIMIT), title: z.string().max(300).optional() }), await readJson(ctx.req, 16 * KB));
  return json(captureText(ctx.db, auth, body.text, body.title ?? ""), 201);
});

// ---- sessions with the public AI self

route("PUT", "public/self/sessions", async (ctx) => {
  const userId = userOf(ctx);
  return json({ offer: saveOffer(ctx.db, userId, parse(z.object({ offer: z.record(z.string(), z.unknown()) }), await readJson(ctx.req, 32 * KB)).offer) });
});

route("GET", "sessions", (ctx) => json(ownerSessions(ctx.db, userOf(ctx))));

route("POST", "sessions/:id/end", (ctx, [bookingId]) => {
  closeSession(ctx.db, userOf(ctx), bookingId, false);
  return json({ ok: true });
});

route("POST", "sessions/:id/block", (ctx, [bookingId]) => {
  closeSession(ctx.db, userOf(ctx), bookingId, true);
  return json({ ok: true });
});

route("GET", "public/at/:handle/sessions", (ctx, [handle]) => {
  rateLimit(`public-read:${clientIp(ctx.req)}`, 120, 60_000);
  assertNotMoved(ctx.db, "public", handle.toLowerCase());
  return json(publicOffer(ctx.db, handle.toLowerCase()));
});

route("POST", "public/at/:handle/sessions", async (ctx, [handle]) => {
  const ip = clientIp(ctx.req);
  rateLimit(`book:${ip}`, 6, 60_000);
  const offer = publicOffer(ctx.db, handle.toLowerCase());
  const body = parse(
    z.object({ id, slotStart: isoTime, topic: z.string().max(80), intake: sealed(32 * KB), tokenHash: sha256Shape, askerKey: boxPublicKey }),
    await readJson(ctx.req, 48 * KB),
  );
  return json(book(ctx.db, handle.toLowerCase(), visitorOf(ip, offer.selfId), { ...body, slotStart: new Date(body.slotStart).toISOString() }), 201);
});

route("GET", "sessions/:id", (ctx, [bookingId]) => {
  rateLimit(`session-read:${clientIp(ctx.req)}`, 240, 60_000);
  return json(sessionStatus(ctx.db, bookingId, sessionBearer(ctx)));
});

route("POST", "sessions/:id/questions", async (ctx, [bookingId]) => {
  rateLimit(`session-ask:${clientIp(ctx.req)}`, 8, 60_000);
  const body = parse(z.object({ id, sealed: relay(64 * KB) }), await readJson(ctx.req, 80 * KB));
  return json(askInSession(ctx.db, bookingId, sessionBearer(ctx), body), 201);
});

route("GET", "sessions/:id/questions/:qid", (ctx, [bookingId, questionId]) => {
  rateLimit(`session-poll:${clientIp(ctx.req)}`, 240, 60_000);
  return json(sessionQuestionStatus(ctx.db, bookingId, sessionBearer(ctx), questionId));
});

// ---- voice: the speech model the page loads when someone turns voice on

route("GET", "voice", () => json({ enabled: serverConfig.voiceEnabled, model: serverConfig.speechModel }));

// ---------------------------------------------------------------- dispatch

// Apps that run in a web page (Sign in with Sigil) call the connector routes from
// their own origin. These routes take a bearer token and never a cookie, so any
// origin may call them; what a token can do is set by the vault owner.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
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
  // Bearer-only routes: connectors, capture keys and node-to-node calls never use a cookie, so any origin may call them.
  if (path[0] === "connector" || (path[0] === "capture" && path[1] === "v1") || (path[0] === "nodes" && path[1] === "moves" && path.length >= 3 && ctx.method !== "DELETE")) {
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
