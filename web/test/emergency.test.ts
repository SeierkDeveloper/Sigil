// The emergency card: encrypted on the device under a key that lives only in
// the link's fragment, served as ciphertext, every opening logged for the owner
// with a device class and a language only, revoked and re-issued.

import { beforeEach, describe, expect, it } from "vitest";
import { cardKeyFromFragment, openCard } from "@sigil/core";
import { count, dumpDb, harness, signedUp, ORIGIN, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import * as em from "../src/vault/emergencyOps";

let h: Harness;
beforeEach(() => {
  h = harness();
});

const HEALTH = "Blood type: O-\nAllergies: CANARY-penicillin\nEmergency contact: Robin, partner, +46 70 000 00 00";

describe("the emergency card", () => {
  it("is drafted from health memories, published as ciphertext, and opened only with the link's key", async () => {
    const o = await signedUp(h);
    const health = await ops.addFolder(o.b.api, o.vault, "Health");
    await ops.createMemory(o.b.api, health, { title: "Medical", body: HEALTH });
    let data = await ops.loadVault(o.b.api, o.vault);
    const draft = em.draftFrom(
      em.healthMemories(data).map((x) => x.memory),
      null,
    );
    expect(draft).toMatchObject({ bloodType: "O-", allergies: "CANARY-penicillin" });

    // The owner edits before publishing: the name is added, the contact kept.
    const view = await em.publishCard(o.b.api, o.vault, data.emergency, { ...draft, name: "Sam" });
    const link = em.emergencyLink(ORIGIN, view)!;
    expect(link.startsWith(`${ORIGIN}/e/${view.card!.id}#`)).toBe(true);
    expect(dumpDb(h.db)).not.toContain("CANARY-penicillin");
    expect(h.sent.join("\n")).not.toContain(link.split("#")[1]);

    // Anyone with the link: ciphertext from the server, the key from the fragment.
    const res = await h.raw("GET", `e/${view.card!.id}`, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "accept-language": "sv-SE,sv;q=0.9", "x-forwarded-for": "198.51.100.4" } });
    const body = (await res.json()) as { card: string };
    const card = await openCard(cardKeyFromFragment(new URL(link).hash)!, view.card!.id, body.card);
    expect(card).toMatchObject({ name: "Sam", bloodType: "O-", allergies: "CANARY-penicillin", contacts: [{ name: "Robin", relation: "partner" }] });

    // The owner sees the opening: a time, a device class, a language, and nothing else.
    data = await ops.loadVault(o.b.api, o.vault);
    expect(data.emergency.opens).toEqual([{ cardId: view.card!.id, at: expect.any(String), device: "phone", lang: "sv" }]);
    expect(dumpDb(h.db)).not.toContain("198.51.100.4");
    expect(dumpDb(h.db)).not.toContain("iPhone");
    expect(data.emergency.card?.card.allergies).toBe("CANARY-penicillin");
    const steps = (await ops.loadLog(o.b.api)).entries.filter((e) => e.kind === "emergency").map((e) => e.memoryId);
    expect(steps).toEqual(expect.arrayContaining(["published", "opened"]));
  });

  it("changes under the same link, re-issues under a new one, and is revoked for good", async () => {
    const o = await signedUp(h);
    let view = await em.publishCard(o.b.api, o.vault, o.data.emergency, { ...em.draftFrom([], null), bloodType: "A+" });
    const first = view.card!.id;
    view = await em.publishCard(o.b.api, o.vault, view, { ...view.card!.card, allergies: "none" });
    expect(view.card!.id).toBe(first);
    view = await em.publishCard(o.b.api, o.vault, view, view.card!.card, true);
    expect(view.card!.id).not.toBe(first);
    expect((await h.raw("GET", `e/${first}`)).status).toBe(404);
    expect((await h.raw("GET", `e/${view.card!.id}`)).status).toBe(200);
    await em.revokeCard(o.b.api, view);
    expect((await h.raw("GET", `e/${view.card!.id}`)).status).toBe(404);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM emergency_cards")).toBe(0);
    // The record of openings stays for the owner.
    expect((await em.refreshOpens(o.b.api)).length).toBe(1);
    const steps = (await ops.loadLog(o.b.api)).entries.filter((e) => e.kind === "emergency").map((e) => e.memoryId);
    expect(steps).toEqual(expect.arrayContaining(["published", "changed", "reissued", "revoked"]));
  });
});
