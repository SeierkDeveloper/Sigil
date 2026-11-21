// The getting-started guide's state, kept as an encrypted setting, and the
// plain words people see when something fails.

import { beforeEach, describe, expect, it } from "vitest";
import { cleanGuide, DecryptError, newGuide, phraseCheckPositions } from "@sigil/core";
import { dumpDb, harness, signedUp, type Harness } from "./helpers";
import * as ops from "../src/vault/ops";
import { currentStep, saveGuide, startGuide, stepStates } from "../src/vault/guideOps";
import { errorText } from "../src/vault/context";
import { ApiError } from "../src/vault/api";

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("the getting-started guide", () => {
  it("is kept encrypted, resumes from the vault itself, and can be skipped step by step", async () => {
    const s = await signedUp(h);
    expect(s.data.guide).toBeNull();
    await startGuide(s.b.api, s.vault);
    let data = await ops.loadVault(s.b.api, s.vault);
    expect(data.guide).toMatchObject({ phraseChecked: true, dismissed: false, skipped: [] });
    expect(currentStep(stepStates(data))).toBe("import");
    expect(dumpDb(h.db)).not.toContain("phraseChecked");

    // An import of a ChatGPT export finishes the step, wherever it was done.
    const folder = await ops.addFolder(s.b.api, s.vault, "ChatGPT");
    await ops.importDrafts(s.b.api, folder, [{ title: "Garden", body: "Tomatoes", source: { kind: "chatgpt", ref: "c1" } }]);
    data = await ops.loadVault(s.b.api, s.vault);
    expect(currentStep(stepStates(data))).toBe("connect");

    await saveGuide(s.b.api, s.vault, { ...data.guide!, skipped: ["connect"] });
    data = await ops.loadVault(s.b.api, s.vault);
    expect(stepStates(data).connect).toBe("skipped");
    expect(currentStep(stepStates(data))).toBe("answer");
    await saveGuide(s.b.api, s.vault, { ...data.guide!, answeredAt: new Date().toISOString(), appId: "app-0000001" });
    data = await ops.loadVault(s.b.api, s.vault);
    expect(currentStep(stepStates(data))).toBeNull();
  });

  it("reads any stored value safely and asks for two different words of the phrase", () => {
    expect(cleanGuide({ skipped: ["import", "nonsense"], dismissed: "yes", appId: "<x>" })).toMatchObject({ skipped: ["import"], dismissed: false, appId: null });
    expect(cleanGuide(null)).toBeNull();
    expect(newGuide(true).phraseChecked).toBe(true);
    for (let i = 0; i < 200; i++) {
      const [a, b] = phraseCheckPositions();
      expect(a).toBeLessThan(b);
      expect(a).toBeGreaterThanOrEqual(1);
      expect(b).toBeLessThanOrEqual(24);
    }
  });
});

describe("error messages people see", () => {
  it("are plain words, never a raw error from deep down", () => {
    expect(errorText(new ApiError(429, "Too many requests. Please wait a moment and try again.", "rate_limited"))).toBe("Too many requests. Please wait a moment and try again.");
    expect(errorText(new TypeError("Failed to fetch"))).toBe("Sigil could not be reached. Check your connection and try again.");
    expect(errorText(new TypeError("Cannot read properties of undefined (reading 'x')"))).toMatch(/^Something went wrong on this page/);
    expect(errorText(Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" }))).toMatch(/cancelled or timed out/);
    expect(errorText(new DecryptError())).toMatch(/could not be opened with your vault key/);
    expect(errorText(new Error("This is not a pack: it is not valid JSON."))).toBe("This is not a pack: it is not valid JSON.");
    expect(errorText("boom")).toBe("Something went wrong. Please try again.");
  });
});
