import { describe, expect, it } from "vitest";
import { cardFromMemories, cardIsEmpty, cardKeyFromFragment, cardUrl, cleanCard, coarseDevice, coarseLanguage, DecryptError, newCardKey, openCard, sealCard, toBase64Url } from "../src";

const memories = [
  { title: "Blood test", body: "Blood type: A positive\nResult fine." },
  { title: "Allergy", body: "Allergies: penicillin\nAllergic to: peanuts" },
  { title: "Daily", body: "Medication: levothyroxine 50 mcg each morning\nConditions: hypothyroidism\nLanguage: English, Swedish" },
  { title: "Who to call", body: "Emergency contact: Robin Example, partner, +46 70 123 45 67" },
];

describe("the emergency card", () => {
  it("is drafted from the health memories the owner picked", () => {
    const c = cardFromMemories(memories, { name: "Sam" });
    expect(c.bloodType).toBe("A+");
    expect(c.allergies).toBe("penicillin\npeanuts");
    expect(c.medication).toContain("levothyroxine");
    expect(c.conditions).toBe("hypothyroidism");
    expect(c.language).toBe("English, Swedish");
    expect(c.contacts).toEqual([{ name: "Robin Example", relation: "partner", phone: "+46 70 123 45 67" }]);
    expect(c.name).toBe("Sam");
    expect(cardIsEmpty(c)).toBe(false);
    expect(cardIsEmpty(cleanCard({}))).toBe(true);
  });

  it("keeps only known blood types and plain phone numbers", () => {
    expect(cleanCard({ bloodType: "Z+" }).bloodType).toBe("");
    expect(cleanCard({ bloodType: "ab neg" }).bloodType).toBe("AB-");
    expect(cleanCard({ contacts: [{ name: "X", phone: "<script>+1 555</script>" }] }).contacts[0].phone).toBe("+1 555");
  });

  it("is encrypted with a key that lives only in the link, bound to its id", async () => {
    const key = newCardKey();
    const card = cardFromMemories(memories, { name: "Sam" });
    const sealed = await sealCard(key, "card-0000001", card);
    expect(sealed).not.toContain("penicillin");
    expect(await openCard(key, "card-0000001", sealed)).toMatchObject({ bloodType: "A+", allergies: "penicillin\npeanuts" });
    await expect(openCard(newCardKey(), "card-0000001", sealed)).rejects.toBeInstanceOf(DecryptError);
    await expect(openCard(key, "card-0000002", sealed)).rejects.toBeInstanceOf(DecryptError);
  });

  it("puts the key after the #, and reads it back", () => {
    const key = newCardKey();
    const url = cardUrl("https://sigil.example/", "card-0000001", key);
    expect(url).toBe(`https://sigil.example/e/card-0000001#${toBase64Url(key)}`);
    expect(cardKeyFromFragment(new URL(url).hash)).toEqual(key);
    expect(cardKeyFromFragment("#short")).toBeNull();
    expect(cardKeyFromFragment("")).toBeNull();
  });

  it("logs openings by device class and language only", () => {
    expect(coarseDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("phone");
    expect(coarseDevice("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile")).toBe("phone");
    expect(coarseDevice("Mozilla/5.0 (Linux; Android 15; SM-X910)")).toBe("tablet");
    expect(coarseDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)")).toBe("computer");
    expect(coarseDevice(null)).toBe("unknown");
    expect(coarseLanguage("sv-SE,sv;q=0.9,en;q=0.8")).toBe("sv");
    expect(coarseLanguage("")).toBe("");
  });
});
