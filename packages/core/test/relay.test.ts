import { describe, expect, it } from "vitest";
import {
  agentSessionKey,
  askUrl,
  createBoxKey,
  DecryptError,
  importKey,
  isRelayBox,
  newAskLink,
  newAskSession,
  openAskMessage,
  openIntro,
  openSetting,
  parseAskFragment,
  randomBytes,
  sealAskMessage,
  sealIntro,
  sealSetting,
  toBase64Url,
} from "../src";

const CANARY = "CANARY-relay-41d2";

describe("the ask link relay", () => {
  it("lets the asker and the owner's agent derive the same key, and only them", async () => {
    const link = newAskLink();
    const session = newAskSession(link.id, link.publicKey);
    const agentKey = agentSessionKey(link.pair, link.id, session.id, session.publicKey);
    expect(toBase64Url(agentKey)).toBe(toBase64Url(session.key));

    const other = newAskLink();
    expect(toBase64Url(agentSessionKey(other.pair, link.id, session.id, session.publicKey))).not.toBe(toBase64Url(session.key));
    // Another conversation on the same link has its own key.
    expect(toBase64Url(newAskSession(link.id, link.publicKey).key)).not.toBe(toBase64Url(session.key));
  });

  it("binds an ask link's conversations to the greeting key from its fragment", () => {
    const link = newAskLink();
    const guest = newAskSession(link.id, link.publicKey, link.introKey);
    expect(toBase64Url(agentSessionKey(link.pair, link.id, guest.id, guest.publicKey, link.introKey))).toBe(toBase64Url(guest.key));
    // Someone who knows only the link's id and public key (the server) makes a session the owner's side cannot open.
    const server = newAskSession(link.id, link.publicKey);
    expect(toBase64Url(agentSessionKey(link.pair, link.id, server.id, server.publicKey, link.introKey))).not.toBe(toBase64Url(server.key));
    expect(() => agentSessionKey(link.pair, link.id, guest.id, guest.publicKey, new Uint8Array(16))).toThrow();
  });

  it("round-trips a question and an answer, and the boxes show nothing readable", () => {
    const link = newAskLink();
    const s = newAskSession(link.id, link.publicKey);
    const ids = { linkId: link.id, sessionId: s.id, messageId: "q-0000000001" };
    const q = sealAskMessage(s.key, ids, "q", { v: 1, text: `What do you eat? ${CANARY}`, history: [] });
    expect(isRelayBox(q)).toBe(true);
    expect(q).not.toContain(CANARY);
    const k = agentSessionKey(link.pair, link.id, s.id, s.publicKey);
    expect(openAskMessage<{ text: string }>(k, ids, "q", q).text).toContain(CANARY);
    const a = sealAskMessage(k, ids, "a", { v: 1, text: "Risotto.", refused: null });
    expect(openAskMessage<{ text: string }>(s.key, ids, "a", a).text).toBe("Risotto.");
  });

  it("fails with the wrong key, a moved box, the wrong direction or any change", () => {
    const link = newAskLink();
    const s = newAskSession(link.id, link.publicKey);
    const ids = { linkId: link.id, sessionId: s.id, messageId: "q-0000000001" };
    const box = sealAskMessage(s.key, ids, "q", { text: "hi" });
    expect(() => openAskMessage(randomBytes(32), ids, "q", box)).toThrow(DecryptError);
    expect(() => openAskMessage(s.key, { ...ids, messageId: "q-0000000002" }, "q", box)).toThrow(DecryptError);
    expect(() => openAskMessage(s.key, { ...ids, sessionId: "other-session" }, "q", box)).toThrow(DecryptError);
    expect(() => openAskMessage(s.key, ids, "a", box)).toThrow(DecryptError);
    const [v, n, ct] = box.split(".");
    const flipped = `${v}.${n}.${ct.slice(0, -2)}${ct.slice(-2) === "AA" ? "AB" : "AA"}`;
    expect(() => openAskMessage(s.key, ids, "q", flipped)).toThrow(DecryptError);
    expect(() => openAskMessage(s.key, ids, "q", "not a box")).toThrow(DecryptError);
  });

  it("puts the link key and the greeting key only in the fragment, and the greeting opens only with it", async () => {
    const link = newAskLink();
    const url = askUrl("https://vault.example/", link.id, link.publicKey, link.introKey);
    const [path, fragment] = url.split("#");
    expect(path).toBe(`https://vault.example/ask/${link.id}`);
    expect(path).not.toContain(link.publicKey);
    const parsed = parseAskFragment(fragment);
    expect(parsed.publicKey).toBe(link.publicKey);
    const intro = await sealIntro(link.introKey, link.id, { name: "Sam's AI self", greeting: `Ask me about boats. ${CANARY}` });
    expect(intro).not.toContain(CANARY);
    expect((await openIntro(parsed.introKey, link.id, intro)).greeting).toContain(CANARY);
    await expect(openIntro(randomBytes(32), link.id, intro)).rejects.toThrow(DecryptError);
    await expect(openIntro(link.introKey, "another-link", intro)).rejects.toThrow(DecryptError);
    expect(() => parseAskFragment(link.publicKey)).toThrow(/incomplete/);
    expect(() => parseAskFragment("short.key")).toThrow(/incomplete/);
  });
});

describe("the model key in the vault", () => {
  it("is stored only as an envelope under the vault key, and opens with nothing else", async () => {
    const vaultKey = await importKey(randomBytes(32));
    const apiKey = "sk-ant-CANARY-model-key-9f2e";
    const env = await sealSetting(vaultKey, "model", { provider: "anthropic", model: "claude-opus-5-5", apiKey });
    expect(env).not.toContain("CANARY");
    expect(env).not.toContain("anthropic");
    expect((await openSetting<{ apiKey: string }>(vaultKey, "model", env)).apiKey).toBe(apiKey);
    await expect(openSetting(await importKey(randomBytes(32)), "model", env)).rejects.toThrow(DecryptError);
    // A setting cannot be passed off as another one.
    await expect(openSetting(vaultKey, "self", env)).rejects.toThrow(DecryptError);
    // The box key made at sign-up is a different key, and does not open it either.
    const { pair } = await createBoxKey(vaultKey);
    await expect(openSetting(await importKey(pair.secretKey), "model", env)).rejects.toThrow(DecryptError);
  });
});
