import { describe, expect, it } from "vitest";
import { tokenConfig, tokenLive } from "../src/server/token";

describe("the token page", () => {
  it("stays off until it is switched on with every address it needs", () => {
    const base = { SIGIL_TOKEN_SYMBOL: "TICKER", SIGIL_TOKEN_ADDRESS: "0x" + "1".repeat(40), SIGIL_BURN_POT: "0x" + "2".repeat(40), SIGIL_TOKEN_RPC: "https://rpc.example" };
    expect(tokenLive(tokenConfig({}))).toBe(false);
    expect(tokenLive(tokenConfig(base))).toBe(false);
    expect(tokenLive(tokenConfig({ ...base, SIGIL_TOKEN: "on" }))).toBe(true);
    expect(tokenLive(tokenConfig({ ...base, SIGIL_TOKEN: "on", SIGIL_BURN_POT: "nope" }))).toBe(false);
  });
});
