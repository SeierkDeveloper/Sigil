// The open standard's test vectors (docs/spec/vectors.json) against the real
// code. Run with SIGIL_WRITE_VECTORS=1 (npm run vectors -w @sigil/core) to
// write them again after a deliberate change to the format.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  boxKeyPairFromSecret,
  decryptBytes,
  decryptJson,
  fromHex,
  importKey,
  meetKey,
  openCard,
  openMeetMessage,
  openSealedJson,
  toHex,
  AAD,
  SPEC_VERSION,
} from "../src";
import { decryptStoredMemory, deterministic, INPUT, sealed } from "./fixtures/spec";

const SPEC = path.resolve(import.meta.dirname, "../../../docs/spec");
const FILE = path.join(SPEC, "vectors.json");

if (process.env.SIGIL_WRITE_VECTORS === "1") {
  it("writes the vectors", async () => {
    // Sealed vectors carry a fresh nonce, so making them again would change them: the ones already published are kept as they are.
    const before = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as { sealed?: Record<string, unknown> }).sealed ?? {} : {};
    const fresh = (await sealed()) as Record<string, unknown>;
    const kept = Object.fromEntries(Object.keys(fresh).map((k) => [k, before[k] ?? fresh[k]]));
    writeFileSync(FILE, `${JSON.stringify({ format: "sigil-spec-vectors", version: SPEC_VERSION, input: INPUT, deterministic: await deterministic(), sealed: kept }, null, 2)}\n`);
  });
} else {
  describe("the open standard's test vectors", () => {
    const vectors = JSON.parse(readFileSync(FILE, "utf8")) as {
      version: string;
      input: typeof INPUT;
      deterministic: Awaited<ReturnType<typeof deterministic>>;
      sealed: Awaited<ReturnType<typeof sealed>>;
    };

    it("are for this version of the standard, with the same inputs", () => {
      expect(vectors.version).toBe(SPEC_VERSION);
      expect(vectors.input).toEqual(INPUT);
    });

    it("match what the code computes, value for value", async () => {
      const now = JSON.parse(JSON.stringify(await deterministic())) as Record<string, unknown>;
      const stored = vectors.deterministic as unknown as Record<string, unknown>;
      for (const key of Object.keys(now)) expect(stored[key], key).toEqual(now[key]);
      expect(Object.keys(vectors.deterministic).sort()).toEqual(Object.keys(now).sort());
    });

    it("open with the keys they name", async () => {
      const s = vectors.sealed;
      const vk = await importKey(fromHex(s.envelope.key));
      expect(toHex(await decryptBytes(vk, s.envelope.envelope, s.envelope.aad))).toBe(s.envelope.plaintextHex);
      const fk = await importKey(fromHex(s.folder.folderKey));
      expect(await decryptJson(fk, s.folder.meta, AAD.folderMeta(s.folder.id))).toEqual(s.folder.opened);
      expect(await decryptStoredMemory(s.memory.folderKey, s.memory.stored)).toMatchObject(s.memory.opened);
      expect(openSealedJson(boxKeyPairFromSecret(fromHex(s.sealedBox.recipientSecret)), s.sealedBox.sealed, s.sealedBox.context)).toEqual(s.sealedBox.plaintext);
      const peer = boxKeyPairFromSecret(fromHex(INPUT.peerSecret));
      const key = meetKey(peer, s.meetMessage.ids.from, s.meetMessage.ids.meetId);
      expect(openMeetMessage(key, s.meetMessage.ids, s.meetMessage.box)).toEqual(s.meetMessage.message);
      expect(await openCard(fromHex(s.emergencyCard.key), s.emergencyCard.cardId, s.emergencyCard.envelope)).toEqual(s.emergencyCard.opened);
    });

    it("are each described in the spec", () => {
      const text = readdirSync(SPEC)
        .filter((f) => f.endsWith(".md"))
        .map((f) => readFileSync(path.join(SPEC, f), "utf8"))
        .join("\n");
      for (const key of [...Object.keys(vectors.deterministic), ...Object.keys(vectors.sealed)]) expect(text, key).toContain(`\`${key}\``);
      expect(existsSync(path.join(SPEC, "README.md"))).toBe(true);
    });
  });
}
