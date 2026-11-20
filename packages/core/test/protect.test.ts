import { describe, expect, it } from "vitest";
import {
  cleanGuard,
  createFolder,
  guardFolder,
  ibanValid,
  luhnValid,
  newVaultKey,
  openFolder,
  redact,
  redactMemory,
  renameFolder,
  rotateFolder,
  vaultCryptoKey,
  REDACT_RULES,
} from "../src";

describe("protected folders", () => {
  it("keep their kind and redaction rules inside the encrypted meta, through rename and rotation", async () => {
    const vk = await vaultCryptoKey(newVaultKey());
    const { stored, folder } = await createFolder(vk, "Health");
    const meta = await guardFolder(folder, { protect: "health", redact: ["phone", "email"] });
    expect(meta).not.toContain("health");
    const opened = await openFolder(vk, { ...stored, meta });
    expect(opened.protect).toBe("health");
    expect(opened.redact).toEqual(["phone", "email"]);

    const renamed = await openFolder(vk, { ...stored, meta: await renameFolder(opened, "Body") });
    expect(renamed).toMatchObject({ name: "Body", protect: "health", redact: ["phone", "email"] });

    const rotated = await rotateFolder(vk, renamed, [], [], []);
    const after = await openFolder(vk, { id: stored.id, meta: rotated.meta, wrappedKey: rotated.wrappedKey });
    expect(after).toMatchObject({ name: "Body", protect: "health" });

    const cleared = await openFolder(vk, { ...stored, meta: await guardFolder(opened, {}) });
    expect(cleared.protect).toBeUndefined();
    expect(cleared.redact).toBeUndefined();
  });

  it("drops unknown kinds and rules", () => {
    expect(cleanGuard({ protect: "secret", redact: ["email", "everything", 3] })).toEqual({ redact: ["email"] });
    expect(cleanGuard({ protect: "money" })).toEqual({ protect: "money" });
    expect(cleanGuard(null)).toEqual({});
  });
});

describe("redaction", () => {
  it("checks card numbers and IBANs before masking them", () => {
    expect(luhnValid("4242 4242 4242 4242")).toBe(true);
    expect(luhnValid("4242 4242 4242 4241")).toBe(false);
    expect(ibanValid("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(ibanValid("GB82 WEST 1234 5698 7654 33")).toBe(false);
  });

  it("masks each kind it is asked to, and nothing else", () => {
    const text = [
      "Card 4242 4242 4242 4242, not 1234 5678 9012 3456.",
      "IBAN GB82 WEST 1234 5698 7654 32.",
      "Call +46 70 123 45 67 or 555-123-4567.",
      "Mail sam@example.org today.",
      "ID 123-45-6789 and 19900101-1234.",
      "Passport number: X1234567.",
      "Account no: 1234-567890 and ref 99887766554.",
      "Meeting on 2026-11-20 at 10:30 in room 12.",
    ].join("\n");
    const all = redact(text, REDACT_RULES);
    expect(all.text).toContain("[card number hidden]");
    expect(all.text).not.toContain("4242 4242");
    expect(all.text).toContain("[IBAN hidden]");
    expect(all.text).not.toContain("WEST 1234");
    expect(all.text).not.toContain("123 45 67");
    expect(all.text).not.toContain("555-123-4567");
    expect(all.text).toContain("[email hidden]");
    expect(all.text).not.toContain("example.org");
    expect(all.text).not.toContain("123-45-6789");
    expect(all.text).not.toContain("19900101-1234");
    expect(all.text).toContain("Passport number: [passport number hidden]");
    expect(all.text).toContain("Account no: [account number hidden]");
    expect(all.text).not.toContain("99887766554");
    // Dates and short numbers are left alone.
    expect(all.text).toContain("2026-11-20 at 10:30 in room 12");
    expect(all.masked.card).toBe(1);
    expect(all.masked.email).toBe(1);

    const emailOnly = redact(text, ["email"]);
    expect(emailOnly.text).toContain("4242 4242 4242 4242");
    expect(emailOnly.text).toContain("[email hidden]");
    expect(redact(text, []).text).toBe(text);
  });

  it("redacts a memory's title, tags, text and first lines", () => {
    const m = redactMemory({ title: "Call 0701234567", body: "Mail sam@example.org", tags: ["sam@example.org"], snippet: "Mail sam@example.org" }, ["email", "phone"]);
    expect(m.title).toBe("Call [phone number hidden]");
    expect(m.body).toBe("Mail [email hidden]");
    expect(m.tags).toEqual(["[email hidden]"]);
    expect(m.snippet).toBe("Mail [email hidden]");
  });
});
