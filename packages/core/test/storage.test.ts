// Where bundles are kept: every backend against HTTP answered by the test (no
// real storage service is ever called), AWS Signature Version 4 against the
// published examples, Arweave data items signed and read back, and the storage
// tokens kept only under the vault key or a connector's key.

import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  backendFor,
  backupDue,
  cleanBackup,
  cleanTarget,
  createDataItem,
  dataItemSignatureData,
  deepHash,
  importKey,
  newAppSecret,
  newVaultKey,
  openBackupForApp,
  openSetting,
  parseDataItem,
  presignGet,
  presignS3Get,
  sealBackupForApp,
  sealSetting,
  serializeTags,
  signV4,
  toBase64Url,
  toHex,
  bundleName,
  type ArweaveTarget,
  type IpfsTarget,
  type S3Target,
} from "../src/index";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function playing(answer: (req: Seen) => Response) {
  const seen: Seen[] = [];
  const fetcher = async (input: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const req: Seen = { url: input, method: init.method ?? "GET", headers, body: init.body };
    seen.push(req);
    return answer(req);
  };
  return { seen, fetcher };
}

const S3: S3Target = {
  kind: "s3",
  id: "target-s3-0001",
  label: "My bucket",
  endpoint: "https://s3.example.test",
  region: "eu-west-1",
  bucket: "my-vault-backups",
  prefix: "sigil/",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "secret-key-of-the-owner",
};

describe("AWS Signature Version 4", () => {
  it("matches the published example of the test suite (get-vanilla)", () => {
    const h = signV4({
      method: "GET",
      url: "https://example.amazonaws.com/",
      region: "us-east-1",
      service: "service",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(h["x-amz-date"]).toBe("20150830T123600Z");
  });

  it("matches the published S3 examples: a GET with a header, and a presigned address", () => {
    const h = signV4({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      headers: { Range: "bytes=0-9" },
      payloadHash: toHex(sha256(new Uint8Array())),
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    const url = presignGet({
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: new Date("2013-05-24T00:00:00Z"),
      expiresSeconds: 86400,
    });
    expect(url).toContain("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });
});

describe("an S3-compatible bucket", () => {
  it("puts the bundle with a signed request and reads it back", async () => {
    const stored = new Map<string, Uint8Array>();
    const { seen, fetcher } = playing((req) => {
      if (req.method === "PUT") {
        stored.set(req.url, req.body as Uint8Array);
        return new Response(null, { status: 200 });
      }
      const got = stored.get(req.url);
      return got ? new Response(got as BodyInit) : new Response("NoSuchKey", { status: 404 });
    });
    const backend = backendFor(S3, fetcher);
    const bytes = new TextEncoder().encode("ciphertext only");
    const place = await backend.put(bytes, "sigil-1.sigil");
    expect(place).toMatchObject({ kind: "s3", ref: "sigil/sigil-1.sigil", url: null, targetId: S3.id });
    expect(seen[0].url).toBe("https://s3.example.test/my-vault-backups/sigil/sigil-1.sigil");
    expect(seen[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(seen[0].headers["x-amz-content-sha256"]).toBe(toHex(sha256(bytes)));
    expect(JSON.stringify(seen)).not.toContain(S3.secretAccessKey);
    expect(await backend.get(place.ref)).toEqual(bytes);
    await expect(backend.get("sigil/missing")).rejects.toThrow(/The bucket answered 404: NoSuchKey/);
    const pre = presignS3Get(S3, place.ref, new Date("2026-11-20T12:00:00Z"));
    expect(pre).toMatch(/^https:\/\/s3\.example\.test\/my-vault-backups\/sigil\/sigil-1\.sigil\?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20261120%2Feu-west-1%2Fs3%2Faws4_request&X-Amz-Date=20261120T120000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=[0-9a-f]{64}$/);
  });
});

describe("IPFS", () => {
  const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

  it("uploads to a pinning service with the owner's token and reads back through a gateway", async () => {
    const { seen, fetcher } = playing((req) =>
      req.method === "POST" ? Response.json({ IpfsHash: CID, PinSize: 15 }) : new Response(new TextEncoder().encode("ciphertext only") as BodyInit),
    );
    const t: IpfsTarget = { kind: "ipfs", id: "target-ipfs-01", label: "Pins", api: "pinning", endpoint: "https://pins.example.test", token: "owner-jwt", gateway: "https://gw.example.test" };
    const place = await backendFor(t, fetcher).put(new TextEncoder().encode("ciphertext only"), "sigil-1.sigil");
    expect(place).toMatchObject({ kind: "ipfs", ref: CID, url: `https://gw.example.test/ipfs/${CID}` });
    expect(seen[0]).toMatchObject({ url: "https://pins.example.test/pinning/pinFileToIPFS", method: "POST", headers: { authorization: "Bearer owner-jwt" } });
    const form = seen[0].body as FormData;
    expect(new TextDecoder().decode(new Uint8Array(await (form.get("file") as Blob).arrayBuffer()))).toBe("ciphertext only");
    expect(new TextDecoder().decode(await backendFor(t, fetcher).get(CID))).toBe("ciphertext only");
    expect(seen[1].url).toBe(`https://gw.example.test/ipfs/${CID}`);
  });

  it("uploads to the owner's own IPFS node, and refuses an answer without a content id", async () => {
    const { seen, fetcher } = playing(() => Response.json({ Name: "sigil-1.sigil", Hash: CID, Size: "23" }));
    const t: IpfsTarget = { kind: "ipfs", id: "target-ipfs-02", label: "My node", api: "node", endpoint: "http://127.0.0.1:5001", token: "", gateway: "http://127.0.0.1:8080" };
    expect((await backendFor(t, fetcher).put(new Uint8Array([1]), "x")).ref).toBe(CID);
    expect(seen[0].url).toBe("http://127.0.0.1:5001/api/v0/add?pin=true&cid-version=1");
    expect(seen[0].headers.authorization).toBeUndefined();
    const bad = playing(() => Response.json({ Hash: "not-a-cid" }));
    await expect(backendFor(t, bad.fetcher).put(new Uint8Array([1]), "x")).rejects.toThrow(/content id/);
  });
});

describe("Arweave", () => {
  async function wallet(): Promise<JsonWebKey> {
    const pair = await crypto.subtle.generateKey({ name: "RSA-PSS", modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    return crypto.subtle.exportKey("jwk", pair.privateKey);
  }

  it("encodes tags as Avro and hashes deeply with SHA-384", () => {
    expect([...serializeTags([{ name: "a", value: "b" }])]).toEqual([2, 2, 97, 2, 98, 0]);
    expect(serializeTags([])).toHaveLength(0);
    const blob = deepHash(new Uint8Array([1, 2, 3]));
    expect(blob).toHaveLength(48);
    expect(deepHash([new Uint8Array([1, 2, 3])])).not.toEqual(blob);
  });

  it("signs a data item with the owner's key on the device, sends it to the bundler and checks the id", async () => {
    const jwk = await wallet();
    const data = new TextEncoder().encode("ciphertext only");
    const item = await createDataItem(data, jwk, [{ name: "Content-Type", value: "application/octet-stream" }]);
    const parsed = parseDataItem(item.bytes);
    expect(parsed.id).toBe(item.id);
    expect(parsed.id).toBe(toBase64Url(sha256(parsed.signature)));
    expect(new TextDecoder().decode(parsed.data)).toBe("ciphertext only");
    const pub = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "PS256", ext: true }, { name: "RSA-PSS", hash: "SHA-256" }, false, ["verify"]);
    const signed = dataItemSignatureData(parsed.owner, parsed.rawTags, parsed.data);
    expect(await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 32 }, pub, parsed.signature.slice().buffer as ArrayBuffer, signed.slice().buffer as ArrayBuffer)).toBe(true);

    const t = cleanTarget({ kind: "arweave", label: "Forever", bundler: "https://bundler.example.test/tx", gateway: "https://gateway.example.test", jwk }) as ArweaveTarget;
    let sentId = "";
    const { seen, fetcher } = playing((req) => {
      if (req.method === "POST") {
        sentId = parseDataItem(req.body as Uint8Array).id;
        return Response.json({ id: sentId });
      }
      return new Response(data as BodyInit);
    });
    const place = await backendFor(t, fetcher).put(data, "sigil-1.sigil");
    expect(place).toMatchObject({ kind: "arweave", ref: sentId, url: `https://gateway.example.test/${sentId}` });
    expect(seen[0].headers["content-type"]).toBe("application/octet-stream");
    expect(JSON.stringify(seen.map((s) => [s.url, s.headers]))).not.toContain(String(jwk.d));
    expect(await backendFor(t, fetcher).get(sentId)).toEqual(data);

    const liar = playing(() => Response.json({ id: "someone-elses-item" }));
    await expect(backendFor(t, liar.fetcher).put(data, "x")).rejects.toThrow(/another id/);
  }, 30_000);
});

describe("the backup setting", () => {
  it("checks each target as the owner types it", () => {
    expect(() => cleanTarget({ kind: "s3", endpoint: "https://s3.example.test", bucket: "Bad_Name", accessKeyId: "a", secretAccessKey: "b" })).toThrow(/bucket needs/);
    expect(() => cleanTarget({ kind: "ipfs", api: "pinning", endpoint: "https://pins.example.test" })).toThrow(/your token/);
    expect(() => cleanTarget({ kind: "arweave", bundler: "https://b.example.test", jwk: { kty: "EC" } })).toThrow(/not an Arweave wallet/);
    expect(() => cleanTarget({ kind: "ftp" })).toThrow(/Choose where/);
    expect(cleanTarget({ ...S3, endpoint: "https://s3.example.test/" }).kind).toBe("s3");
    expect(cleanBackup({ targets: [S3, { kind: "nonsense" }], every: "weekly" })).toEqual({ v: 1, targets: [S3], every: "weekly" });
    expect(cleanBackup(null)).toEqual({ v: 1, targets: [], every: "off" });
    expect(bundleName(`0x${"ab".repeat(32)}`, new Date("2026-11-20T12:00:00.123Z"))).toBe("sigil-20261120T120000Z-abababababab.sigil");
  });

  it("is due by its schedule only", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    expect(backupDue("off", null, now)).toBe(false);
    expect(backupDue("daily", null, now)).toBe(true);
    expect(backupDue("daily", "2026-11-19T13:00:00Z", now)).toBe(false);
    expect(backupDue("daily", "2026-11-19T11:00:00Z", now)).toBe(true);
    expect(backupDue("weekly", "2026-11-15T12:00:00Z", now)).toBe(false);
  });

  it("keeps the tokens only under the vault key, or a key from the connector's own secret", async () => {
    const key = await importKey(newVaultKey());
    const setting = { v: 1, targets: [S3], every: "daily" };
    const envelope = await sealSetting(key, "backup", setting);
    expect(envelope).not.toContain(S3.secretAccessKey);
    expect(cleanBackup(await openSetting(key, "backup", envelope))).toEqual(setting);
    await expect(openSetting(await importKey(newVaultKey()), "backup", envelope)).rejects.toThrow();

    const secret = newAppSecret();
    const forApp = await sealBackupForApp(secret, "app-0000001", { v: 1, targets: [S3], every: "daily", boxPublic: "x".repeat(43) });
    expect(forApp).not.toContain(S3.secretAccessKey);
    expect((await openBackupForApp(secret, "app-0000001", forApp)).targets).toEqual([S3]);
    await expect(openBackupForApp(secret, "app-0000002", forApp)).rejects.toThrow();
    await expect(openBackupForApp(newAppSecret(), "app-0000001", forApp)).rejects.toThrow();
  });
});
