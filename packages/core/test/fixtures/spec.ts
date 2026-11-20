// The test vectors of the Sigil open standard (docs/spec/vectors.json), built
// from the real code. Every value that follows from its inputs alone is
// computed again by the check and must match to the byte. Values made with a
// fresh random nonce (envelopes, sealed boxes) cannot be made again; for those
// the check opens the stored value with the stored key and compares the result.

import {
  AAD,
  agentSessionKey,
  appKeys,
  appSelfKey,
  appSyncKey,
  boxKeyPairFromSecret,
  buildCertificate,
  buildMemory,
  canonicalJson,
  decryptMemory,
  encryptJson,
  encodeBoxPublicKey,
  encryptBytes,
  encryptMemory,
  formatVaultCode,
  fromHex,
  hex32,
  hkdf,
  importKey,
  leafHash,
  meetKey,
  merkleProof,
  merkleRoot,
  phraseKeys,
  pkceChallenge,
  presenceMessage,
  privacyScore,
  publicCopyHash,
  readEntryLeafData,
  redact,
  sealJson,
  sealMeetMessage,
  signPresence,
  syncMemoryId,
  toBase64Url,
  toHex,
  tokenHash,
  vaultFingerprint,
  vaultSigningKey,
  walletKeys,
  REDACT_RULES,
} from "../../src";

export const H = (n: number, len = 32) => Uint8Array.from({ length: len }, (_, i) => (i * 7 + n) & 0xff);

export const INPUT = {
  vaultKey: toHex(H(1)),
  folderKey: toHex(H(2)),
  appSecret: toHex(H(3)),
  boxSecret: toHex(H(4)),
  peerSecret: toHex(H(5)),
  linkSecret: toHex(H(6)),
  phrase: `${"abandon ".repeat(23)}art`,
  wallet: { address: "0x000000000000000000000000000000000000dEaD", signature: `0x${toHex(H(9, 65))}` },
  appId: "app-0000001",
  folderId: "folder-00001",
  memoryId: "memory-00001",
  meetId: "meet-0000001",
  linkId: "link-0000001",
  sessionId: "session-00001",
};

/** Values that follow from the inputs alone. The check computes these again. */
export async function deterministic() {
  const vault = fromHex(INPUT.vaultKey);
  const secret = fromHex(INPUT.appSecret);
  const box = boxKeyPairFromSecret(fromHex(INPUT.boxSecret));
  const peer = boxKeyPairFromSecret(fromHex(INPUT.peerSecret));
  const link = boxKeyPairFromSecret(fromHex(INPUT.linkSecret));
  const app = await appKeys(secret);
  const phrase = await phraseKeys(INPUT.phrase);
  const wallet = await walletKeys(INPUT.wallet.address, INPUT.wallet.signature);
  const signing = await vaultSigningKey(vault);
  const boxPublic = encodeBoxPublicKey(box.publicKey);
  const peerPublic = encodeBoxPublicKey(peer.publicKey);

  const entry = { id: "entry-000001", appId: INPUT.appId, kind: "protected" as const, memoryId: INPUT.memoryId, count: 1, at: "2026-11-20T10:15:00.000Z", salt: "ab".repeat(32) };
  const leaves = ["a", "b", "c", "d", "e"].map((x) => leafHash(x));
  const cert = buildCertificate(signing, {
    origin: "https://vault.example",
    periodSeconds: 3600,
    issuedAt: "2026-11-20T12:00:00.000Z",
    hours: [{ hour: 491_000, entry: { id: "entry-000002", at: new Date(491_000 * 3_600_000 + 60_000).toISOString(), salt: "cd".repeat(32), sig: signPresence(signing, "https://vault.example", 491_000, 3600) }, index: 0, proof: [], root: hex32(leafHash("x")) }],
  });
  const redactText = "Card 4242 4242 4242 4242, IBAN GB82 WEST 1234 5698 7654 32, call +46 70 123 45 67, mail sam@example.org, ID 123-45-6789, passport no. X1234567, account 1234-5678901.";
  const score = privacyScore({
    entries: [
      { kind: "read", memoryId: "m1", count: 1, at: "2026-11-19T10:00:00.000Z" },
      { kind: "protected", memoryId: "m2", count: 1, at: "2026-11-18T10:00:00.000Z" },
      { kind: "propose", memoryId: "p1", count: 1, at: "2026-11-18T11:00:00.000Z" },
    ],
    memoryFolder: new Map([
      ["m1", "work"],
      ["m2", "health"],
    ]),
    folders: [
      { id: "work", name: "Work" },
      { id: "health", name: "Health", protect: "health" },
    ],
    readable: 10,
    now: Date.parse("2026-11-20T12:00:00.000Z"),
  });

  return {
    hkdf: {
      secret: INPUT.appSecret,
      outputs: Object.fromEntries(
        await Promise.all(["sigil:auth:app", "sigil:wrap:app", "sigil:wrap:self", "sigil:wrap:sync", "sigil:tag:app-box", "sigil:kek:passkey"].map(async (info) => [info, toHex(await hkdf(secret, info))])),
      ),
    },
    appKey: {
      secret: INPUT.appSecret,
      key: `sigil_app.${INPUT.appId}.${toBase64Url(secret)}`,
      authToken: app.authToken,
      tokenHash: tokenHash(app.authToken),
      wrapKey: toHex(app.wrapKey),
      selfKey: toHex(await appSelfKey(secret)),
      syncKey: toHex(await appSyncKey(secret)),
    },
    phrase: { phrase: INPUT.phrase, kek: toHex(phrase.kek), authToken: phrase.authToken, lookupId: phrase.lookupId },
    wallet: { ...INPUT.wallet, kek: toHex(wallet.kek), authToken: wallet.authToken },
    aad: {
      folderKey: AAD.folderKey(INPUT.folderId),
      folderMeta: AAD.folderMeta(INPUT.folderId),
      memoryHead: AAD.memoryHead(INPUT.memoryId),
      memoryBody: AAD.memoryBody(INPUT.memoryId),
      appFolderKey: AAD.appFolderKey(INPUT.appId, INPUT.folderId),
      syncOwner: AAD.syncOwner("source-0001"),
      publicOwner: AAD.publicOwner("public-0001"),
      meetOwner: AAD.meetOwner(INPUT.meetId),
    },
    vaultCode: { publicKey: boxPublic, secret: INPUT.boxSecret, code: formatVaultCode(boxPublic), fingerprint: vaultFingerprint(boxPublic) },
    merkle: {
      leafData: ["a", "b", "c", "d", "e"],
      leaves: leaves.map(hex32),
      root: hex32(merkleRoot(leaves)),
      proofOf3: merkleProof(leaves, 3).map(hex32),
    },
    readEntry: { entry, leafData: readEntryLeafData(entry), leaf: hex32(leafHash(readEntryLeafData(entry))) },
    presence: {
      vaultKey: INPUT.vaultKey,
      signingKey: signing.publicKey,
      message: presenceMessage("https://vault.example", 491_000, 3600),
      signature: signPresence(signing, "https://vault.example", 491_000, 3600),
    },
    certificate: { canonicalBody: canonicalJson(cert.body), signature: cert.signature },
    pkce: { verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r7wW1gFWFOEjXk", challenge: pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r7wW1gFWFOEjXk") },
    syncId: { folderKey: INPUT.folderKey, kind: "gmail", ref: "1784231987650000000", id: await syncMemoryId(fromHex(INPUT.folderKey), "gmail", "1784231987650000000") },
    redaction: { text: redactText, rules: [...REDACT_RULES], output: redact(redactText, REDACT_RULES).text, emailOnly: redact(redactText, ["email"]).text },
    meetKey: {
      secretA: INPUT.boxSecret,
      secretB: INPUT.peerSecret,
      publicA: boxPublic,
      publicB: peerPublic,
      meetId: INPUT.meetId,
      key: toHex(meetKey(box, peerPublic, INPUT.meetId)),
      aad: `sigil:meet-msg:v1:${INPUT.meetId}:1:${boxPublic}`,
    },
    askKey: {
      linkSecret: INPUT.linkSecret,
      linkPublic: encodeBoxPublicKey(link.publicKey),
      askerPublic: peerPublic,
      linkId: INPUT.linkId,
      sessionId: INPUT.sessionId,
      key: toHex(agentSessionKey(link, INPUT.linkId, INPUT.sessionId, peerPublic)),
    },
    publicCopy: {
      items: [{ id: "item-000001", title: "Talks", body: "I give talks.", tags: ["work"], editedAt: "2026-11-01T00:00:00.000Z" }],
      hash: publicCopyHash([{ id: "item-000001", title: "Talks", body: "I give talks.", tags: ["work"], editedAt: "2026-11-01T00:00:00.000Z" }]),
    },
    privacyScore: { score: score.score, level: score.level, parts: score.parts.map((p) => [p.key, p.points]) },
  };
}

/** Values made with a fresh nonce. The check opens them and compares what is inside. */
export async function sealed() {
  const vk = await importKey(fromHex(INPUT.vaultKey));
  const raw = fromHex(INPUT.folderKey);
  const key = await importKey(raw);
  const meta = await encryptJson(key, { name: "Notes", protect: "health", redact: ["email"] }, AAD.folderMeta(INPUT.folderId));
  const memory = buildMemory({ title: "Hello", body: "The first memory.", tags: ["spec"], createdAt: "2026-11-20T00:00:00.000Z", editedAt: "2026-11-20T00:00:00.000Z" }, INPUT.folderId, INPUT.memoryId);
  const enc = await encryptMemory({ id: INPUT.folderId, key }, memory);
  const box = boxKeyPairFromSecret(fromHex(INPUT.boxSecret));
  const peer = boxKeyPairFromSecret(fromHex(INPUT.peerSecret));
  return {
    envelope: { key: INPUT.vaultKey, aad: AAD.folderKey(INPUT.folderId), plaintextHex: INPUT.folderKey, envelope: await encryptBytes(vk, raw, AAD.folderKey(INPUT.folderId)) },
    folder: { folderKey: INPUT.folderKey, id: INPUT.folderId, meta, opened: { name: "Notes", protect: "health", redact: ["email"] } },
    memory: { folderKey: INPUT.folderKey, stored: enc, opened: { title: "Hello", body: "The first memory.", tags: ["spec"] } },
    sealedBox: { recipientSecret: INPUT.boxSecret, context: "proposal:prop-0001:app-0000001", plaintext: { v: 1, title: "A suggestion" }, sealed: sealJson(box.publicKey, { v: 1, title: "A suggestion" }, "proposal:prop-0001:app-0000001") },
    meetMessage: {
      ids: { meetId: INPUT.meetId, turn: 1, from: encodeBoxPublicKey(box.publicKey) },
      message: { v: 1, text: "Tuesday at 14:00?", done: false },
      box: sealMeetMessage(meetKey(box, encodeBoxPublicKey(peer.publicKey), INPUT.meetId), { meetId: INPUT.meetId, turn: 1, from: encodeBoxPublicKey(box.publicKey) }, { v: 1, text: "Tuesday at 14:00?", done: false }),
    },
  };
}

export async function decryptStoredMemory(folderKeyHex: string, stored: { id: string; folderId: string; head: string; body?: string }) {
  return decryptMemory({ key: await importKey(fromHex(folderKeyHex)) }, stored);
}
