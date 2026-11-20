// Where a vault bundle is kept, behind one interface. Every backend is the
// owner's own: their S3-compatible bucket, an IPFS pinning service or their own
// IPFS node with their own token, Arweave through a bundler with their own
// wallet, or a file they download. The tokens are kept in the vault's "backup"
// setting, encrypted with the vault key, and the upload runs on the owner's
// device (the vault page, or the connector on their machine). The node never
// sees a token, and the bundle it would see is ciphertext anyway.
//
// How long a bundle lasts depends on the backend the owner chose: a bucket
// keeps it while the account is paid and the object is not deleted, a pinning
// service while the pin is kept, Arweave for as long as its network stores
// what was paid for. Sigil does not pay for, extend or check any of that.

import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha384 } from "@noble/hashes/sha2.js";
import { decryptJson, encryptJson, hkdf, importKey, randomId } from "./crypto";
import { concatBytes, fromBase64Url, toBase64Url, toHex, utf8 } from "./encoding";
import { AAD } from "./keys";
import type { Fetcher } from "./client";

export type BackupKind = "s3" | "ipfs" | "arweave";
export const BACKUP_KINDS: readonly BackupKind[] = ["s3", "ipfs", "arweave"];

export interface S3Target {
  kind: "s3";
  id: string;
  label: string;
  /** The service address, for example https://s3.eu-central-1.amazonaws.com or another S3-compatible host. */
  endpoint: string;
  region: string;
  bucket: string;
  /** Objects are named <prefix>sigil-<time>-<hash>.sigil */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface IpfsTarget {
  kind: "ipfs";
  id: string;
  label: string;
  /** "pinning" for a pinning service with a file upload (Pinata's pinFileToIPFS), "node" for an IPFS node's own API (/api/v0/add). */
  api: "pinning" | "node";
  endpoint: string;
  /** Sent as a bearer token. May be empty for a node on the owner's own network. */
  token: string;
  /** Where the bundle is read back from: <gateway>/ipfs/<cid>. */
  gateway: string;
}

export interface ArweaveTarget {
  kind: "arweave";
  id: string;
  label: string;
  /** The bundler's upload address, which takes a signed data item: for example https://upload.ardrive.io/v1/tx */
  bundler: string;
  /** Where the bundle is read back from: <gateway>/<id>. */
  gateway: string;
  /** The owner's Arweave wallet: an RSA key as a JSON Web Key. */
  jwk: JsonWebKey;
}

export type BackupTarget = S3Target | IpfsTarget | ArweaveTarget;

/** Where one bundle was put. Kept encrypted for the owner; enough to read it back. */
export interface BackupPlace {
  targetId: string;
  kind: BackupKind | "file";
  label: string;
  /** The object key, the content id or the transaction id. */
  ref: string;
  /** A public address it can be read from, when there is one. */
  url: string | null;
  at: string;
}

export interface StorageBackend {
  readonly target: BackupTarget;
  put(bytes: Uint8Array, name: string): Promise<BackupPlace>;
  get(ref: string): Promise<Uint8Array>;
}

const clean = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const httpUrl = (v: unknown): string => {
  const s = clean(v, 500).replace(/\/+$/, "");
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? s : "";
  } catch {
    return "";
  }
};

/** A target as typed by the owner, checked. Throws with a plain message when something needed is missing. */
export function cleanTarget(value: unknown): BackupTarget {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const id = typeof v.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v.id) ? v.id : randomId();
  const label = clean(v.label, 80);
  if (v.kind === "s3") {
    const t: S3Target = {
      kind: "s3",
      id,
      label: label || "S3 bucket",
      endpoint: httpUrl(v.endpoint),
      region: clean(v.region, 40) || "us-east-1",
      bucket: clean(v.bucket, 63),
      prefix: clean(v.prefix, 200).replace(/^\/+/, ""),
      accessKeyId: clean(v.accessKeyId, 128),
      secretAccessKey: clean(v.secretAccessKey, 256),
    };
    if (!t.endpoint || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(t.bucket) || !t.accessKeyId || !t.secretAccessKey) {
      throw new Error("A bucket needs its address, its name, an access key id and a secret key.");
    }
    return t;
  }
  if (v.kind === "ipfs") {
    const t: IpfsTarget = {
      kind: "ipfs",
      id,
      label: label || "IPFS",
      api: v.api === "node" ? "node" : "pinning",
      endpoint: httpUrl(v.endpoint),
      token: clean(v.token, 4000),
      gateway: httpUrl(v.gateway) || "https://ipfs.io",
    };
    if (!t.endpoint || (t.api === "pinning" && !t.token)) throw new Error("IPFS needs the service address and, for a pinning service, your token.");
    return t;
  }
  if (v.kind === "arweave") {
    const jwk = (v.jwk && typeof v.jwk === "object" ? v.jwk : null) as JsonWebKey | null;
    const t: ArweaveTarget = { kind: "arweave", id, label: label || "Arweave", bundler: httpUrl(v.bundler), gateway: httpUrl(v.gateway) || "https://arweave.net", jwk: jwk ?? {} };
    if (!t.bundler) throw new Error("Arweave needs the address of the bundler that takes your upload.");
    if (!jwk || jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.d !== "string" || fromBase64Url(jwk.n).length !== 512) {
      throw new Error("That is not an Arweave wallet file. It is a JSON key with kty RSA and a 4096-bit modulus.");
    }
    return t;
  }
  throw new Error("Choose where to store the bundle: a bucket, IPFS or Arweave.");
}

/** The name a bundle is stored under. */
export function bundleName(hash: string, at = new Date()): string {
  return `sigil-${at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${hash.slice(2, 14)}.sigil`;
}

async function ok(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 200).replace(/\s+/g, " ").trim();
  } catch {
    detail = "";
  }
  throw new Error(`${what} answered ${res.status}${detail ? `: ${detail}` : ""}.`);
}

async function bytesOf(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

/** One interface over every backend. Requests go through the fetcher given, so tests answer them and the connector brings its own. */
export function backendFor(target: BackupTarget, fetcher: Fetcher = (i, init) => fetch(i, init)): StorageBackend {
  if (target.kind === "s3") return s3Backend(target, fetcher);
  if (target.kind === "ipfs") return ipfsBackend(target, fetcher);
  return arweaveBackend(target, fetcher);
}

// ---------------------------------------------------------------- S3-compatible buckets, with AWS Signature Version 4

const hex = (b: Uint8Array) => toHex(b);
const hmacOf = (key: Uint8Array, text: string) => hmac(sha256, key, utf8(text));

/** RFC 3986 encoding, as Signature Version 4 wants it. Slashes kept in paths. */
export function uriEncode(text: string, keepSlash: boolean): string {
  let out = "";
  for (const b of utf8(text)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9_.~-]/.test(c) || (keepSlash && c === "/")) out += c;
    else out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export interface SignInput {
  method: string;
  url: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Headers to sign besides host and x-amz-date. */
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body, or UNSIGNED-PAYLOAD. Sent as x-amz-content-sha256 when set. */
  payloadHash?: string;
  /** Sign the body hash without sending x-amz-content-sha256 (the general form of the algorithm). */
  bodyHash?: string;
  now: Date;
}

/** AWS Signature Version 4: the headers to send, with Authorization. */
export function signV4(input: SignInput): Record<string, string> {
  const url = new URL(input.url);
  const amzDate = input.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: url.host, "x-amz-date": amzDate };
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  if (input.payloadHash) headers["x-amz-content-sha256"] = input.payloadHash;
  const names = Object.keys(headers).sort();
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const path = uriEncode(decodeURIComponent(url.pathname || "/"), true);
  const canonical = [
    input.method.toUpperCase(),
    path,
    query,
    ...names.map((n) => `${n}:${headers[n]}`),
    "",
    names.join(";"),
    input.payloadHash ?? input.bodyHash ?? hex(sha256(new Uint8Array())),
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(sha256(utf8(canonical)))].join("\n");
  let key = hmacOf(utf8(`AWS4${input.secretAccessKey}`), day);
  key = hmacOf(key, input.region);
  key = hmacOf(key, input.service);
  key = hmacOf(key, "aws4_request");
  const signature = hex(hmacOf(key, toSign));
  const { host: _host, ...send } = headers;
  return { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

/** A presigned GET address (Signature Version 4 in the query string). */
export function presignGet(input: { url: string; region: string; service: string; accessKeyId: string; secretAccessKey: string; now: Date; expiresSeconds: number }): string {
  const url = new URL(input.url);
  const amzDate = input.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const scope = `${amzDate.slice(0, 8)}/${input.region}/${input.service}/aws4_request`;
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${input.accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(Math.min(Math.max(Math.floor(input.expiresSeconds), 1), 604_800)));
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = ["GET", uriEncode(decodeURIComponent(url.pathname || "/"), true), query, `host:${url.host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(sha256(utf8(canonical)))].join("\n");
  let k = hmacOf(utf8(`AWS4${input.secretAccessKey}`), amzDate.slice(0, 8));
  k = hmacOf(k, input.region);
  k = hmacOf(k, input.service);
  k = hmacOf(k, "aws4_request");
  return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${hex(hmacOf(k, toSign))}`;
}

/** A presigned address to read one bundle, made on the owner's device: a node can fetch it for a restore without ever holding the keys. */
export function presignS3Get(target: S3Target, key: string, now = new Date(), expiresSeconds = 900): string {
  return presignGet({ url: objectUrl(target, key), region: target.region, service: "s3", accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey, now, expiresSeconds });
}

function objectUrl(t: S3Target, key: string): string {
  // Path style works with every S3-compatible service: <endpoint>/<bucket>/<key>.
  return `${t.endpoint}/${t.bucket}/${uriEncode(key, true)}`;
}

function s3Backend(t: S3Target, fetcher: Fetcher): StorageBackend {
  return {
    target: t,
    async put(bytes, name) {
      const key = `${t.prefix}${name}`;
      const url = objectUrl(t, key);
      const headers = signV4({
        method: "PUT",
        url,
        region: t.region,
        service: "s3",
        accessKeyId: t.accessKeyId,
        secretAccessKey: t.secretAccessKey,
        headers: { "content-type": "application/octet-stream" },
        payloadHash: hex(sha256(bytes)),
        now: new Date(),
      });
      await ok(await fetcher(url, { method: "PUT", headers, body: bytes as BodyInit }), "The bucket");
      return { targetId: t.id, kind: "s3", label: t.label, ref: key, url: null, at: new Date().toISOString() };
    },
    async get(key) {
      const url = objectUrl(t, key);
      const headers = signV4({ method: "GET", url, region: t.region, service: "s3", accessKeyId: t.accessKeyId, secretAccessKey: t.secretAccessKey, payloadHash: hex(sha256(new Uint8Array())), now: new Date() });
      return bytesOf(await ok(await fetcher(url, { headers }), "The bucket"));
    },
  };
}

// ---------------------------------------------------------------- IPFS

export const CID_PATTERN = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

function ipfsBackend(t: IpfsTarget, fetcher: Fetcher): StorageBackend {
  return {
    target: t,
    async put(bytes, name) {
      const form = new FormData();
      form.append("file", new Blob([bytes as BlobPart], { type: "application/octet-stream" }), name);
      const headers: Record<string, string> = t.token ? { authorization: `Bearer ${t.token}` } : {};
      let cid: string;
      if (t.api === "pinning") {
        form.append("pinataMetadata", JSON.stringify({ name }));
        const res = await ok(await fetcher(`${t.endpoint}/pinning/pinFileToIPFS`, { method: "POST", headers, body: form }), "The pinning service");
        cid = String(((await res.json()) as { IpfsHash?: unknown }).IpfsHash ?? "");
      } else {
        const res = await ok(await fetcher(`${t.endpoint}/api/v0/add?pin=true&cid-version=1`, { method: "POST", headers, body: form }), "The IPFS node");
        cid = String(((await res.json()) as { Hash?: unknown }).Hash ?? "");
      }
      if (!CID_PATTERN.test(cid)) throw new Error("The IPFS service did not return a content id.");
      return { targetId: t.id, kind: "ipfs", label: t.label, ref: cid, url: ipfsUrl(t.gateway, cid), at: new Date().toISOString() };
    },
    async get(cid) {
      return bytesOf(await ok(await fetcher(ipfsUrl(t.gateway, cid)), "The IPFS gateway"));
    },
  };
}

export function ipfsUrl(gateway: string, cid: string): string {
  return `${gateway.replace(/\/+$/, "")}/ipfs/${cid}`;
}

// ---------------------------------------------------------------- Arweave: a signed data item (ANS-104) sent to a bundler

/** Arweave's deep hash, SHA-384 over a tree of byte strings. */
export function deepHash(data: Uint8Array | Uint8Array[]): Uint8Array {
  if (Array.isArray(data)) {
    let acc = sha384(utf8(`list${data.length}`));
    for (const chunk of data) acc = sha384(concatBytes(acc, deepHash(chunk)));
    return acc;
  }
  return sha384(concatBytes(sha384(utf8(`blob${data.byteLength}`)), sha384(data)));
}

function zigzagLong(n: number): Uint8Array {
  let v = BigInt(n);
  v = v >= 0n ? v << 1n : (-v << 1n) - 1n;
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Uint8Array.from(out);
}

/** Tags as ANS-104 wants them: an Avro array of records of two byte strings. */
export function serializeTags(tags: { name: string; value: string }[]): Uint8Array {
  if (tags.length === 0) return new Uint8Array();
  const parts: Uint8Array[] = [zigzagLong(tags.length)];
  for (const t of tags) {
    for (const s of [utf8(t.name), utf8(t.value)]) parts.push(zigzagLong(s.length), s);
  }
  parts.push(zigzagLong(0));
  return concatBytes(...parts);
}

function le(n: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let v = BigInt(n);
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export interface DataItem {
  id: string;
  bytes: Uint8Array;
}

/** The bytes an Arweave RSA key signs for a data item: the deep hash of its fields. */
export function dataItemSignatureData(owner: Uint8Array, rawTags: Uint8Array, data: Uint8Array): Uint8Array {
  return deepHash([utf8("dataitem"), utf8("1"), utf8("1"), owner, new Uint8Array(), new Uint8Array(), rawTags, data]);
}

/** A data item signed with the owner's Arweave key (signature type 1, RSA-PSS with SHA-256), in WebCrypto on the device. */
export async function createDataItem(data: Uint8Array, jwk: JsonWebKey, tags: { name: string; value: string }[]): Promise<DataItem> {
  const owner = fromBase64Url(String(jwk.n ?? ""));
  if (owner.length !== 512) throw new Error("That Arweave key is not 4096 bits.");
  const rawTags = serializeTags(tags);
  const key = await globalThis.crypto.subtle.importKey("jwk", { ...jwk, alg: "PS256", ext: true } as JsonWebKey, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
  const message = dataItemSignatureData(owner, rawTags, data);
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, key, message.slice().buffer as ArrayBuffer));
  if (signature.length !== 512) throw new Error("The Arweave key made a signature of the wrong size.");
  const bytes = concatBytes(le(1, 2), signature, owner, Uint8Array.of(0), Uint8Array.of(0), le(tags.length, 8), le(rawTags.length, 8), rawTags, data);
  return { id: toBase64Url(sha256(signature)), bytes };
}

/** Reads the fields back out of a data item, to check one. */
export function parseDataItem(bytes: Uint8Array): { signatureType: number; signature: Uint8Array; owner: Uint8Array; rawTags: Uint8Array; data: Uint8Array; id: string } {
  const signatureType = bytes[0] | (bytes[1] << 8);
  if (signatureType !== 1) throw new Error("Only Arweave-signed data items are read here.");
  const signature = bytes.slice(2, 514);
  const owner = bytes.slice(514, 1026);
  let p = 1026;
  if (bytes[p] === 1) p += 32;
  p += 1;
  if (bytes[p] === 1) p += 32;
  p += 1;
  const tagBytes = Number(new DataView(bytes.buffer, bytes.byteOffset + p + 8, 8).getBigUint64(0, true));
  const rawTags = bytes.slice(p + 16, p + 16 + tagBytes);
  return { signatureType, signature, owner, rawTags, data: bytes.slice(p + 16 + tagBytes), id: toBase64Url(sha256(signature)) };
}

function arweaveBackend(t: ArweaveTarget, fetcher: Fetcher): StorageBackend {
  return {
    target: t,
    async put(bytes) {
      const item = await createDataItem(bytes, t.jwk, [
        { name: "Content-Type", value: "application/octet-stream" },
        { name: "App-Name", value: "Sigil" },
      ]);
      const res = await ok(await fetcher(t.bundler, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: item.bytes as BodyInit }), "The bundler");
      let answered = item.id;
      try {
        const j = (await res.json()) as { id?: unknown };
        if (typeof j.id === "string") answered = j.id;
      } catch {
        answered = item.id;
      }
      if (answered !== item.id) throw new Error("The bundler answered with another id than the item it was given.");
      return { targetId: t.id, kind: "arweave", label: t.label, ref: item.id, url: `${t.gateway.replace(/\/+$/, "")}/${item.id}`, at: new Date().toISOString() };
    },
    async get(id) {
      return bytesOf(await ok(await fetcher(`${t.gateway.replace(/\/+$/, "")}/${id}`), "The Arweave gateway"));
    },
  };
}

// ---------------------------------------------------------------- the backup setting

export type BackupEvery = "off" | "daily" | "weekly";

/** The vault's "backup" setting: kept under the vault key, never readable on a node. */
export interface BackupSettings {
  v: 1;
  targets: BackupTarget[];
  every: BackupEvery;
}

export const EMPTY_BACKUP: BackupSettings = { v: 1, targets: [], every: "off" };
export const BACKUP_TARGET_LIMIT = 8;

export function cleanBackup(value: unknown): BackupSettings {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const targets: BackupTarget[] = [];
  for (const t of Array.isArray(v.targets) ? v.targets : []) {
    try {
      targets.push(cleanTarget(t));
    } catch {
      // A target that no longer passes the checks is left out rather than used.
    }
  }
  return { v: 1, targets: targets.slice(0, BACKUP_TARGET_LIMIT), every: v.every === "daily" || v.every === "weekly" ? v.every : "off" };
}

export function backupDue(every: BackupEvery, lastAt: string | null, now = Date.now()): boolean {
  if (every === "off") return false;
  if (!lastAt) return true;
  const gap = (every === "daily" ? 1 : 7) * 86_400_000;
  return now - Date.parse(lastAt) >= gap;
}

/** The key that wraps the backup targets for a connector the owner lets back up in the background. */
export async function appBackupKey(secret: Uint8Array): Promise<Uint8Array> {
  return hkdf(secret, "sigil:wrap:backup");
}

/** What a connector receives: the targets, how often, and the vault public key to seal its run records to. */
export interface AppBackup {
  v: 1;
  targets: BackupTarget[];
  every: BackupEvery;
  boxPublic: string;
}

export async function sealBackupForApp(secret: Uint8Array, appId: string, value: AppBackup): Promise<string> {
  return encryptJson(await importKey(await appBackupKey(secret)), value, AAD.backupApp(appId));
}

export async function openBackupForApp(secret: Uint8Array, appId: string, envelope: string): Promise<AppBackup> {
  const v = await decryptJson<AppBackup>(await importKey(await appBackupKey(secret)), envelope, AAD.backupApp(appId));
  const c = cleanBackup(v);
  return { v: 1, targets: c.targets, every: c.every, boxPublic: String(v.boxPublic ?? "") };
}

/** A record of one backup, sealed to the vault public key: which places hold the bundle. */
export interface BackupRecord {
  v: 1;
  hash: string;
  size: number;
  places: BackupPlace[];
  failed: { targetId: string; label: string; reason: string }[];
  by: "vault" | "connector";
}

export function backupRecordContext(runId: string): string {
  return `backup-run:${runId}`;
}
