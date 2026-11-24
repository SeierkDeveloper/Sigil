import { describe, expect, it } from "vitest";
import { cleanModelSettings, createModelCaller, maskKey, ModelError } from "../src";

const KEY = "sk-ant-test-0123456789abcdef";

function anthropicReply(text: string, stop = "end_turn") {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: text ? [{ type: "text", text }] : [],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

/** A stand-in for the provider: records each request and answers from a script. No network. */
function provider(status: number, body: unknown) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": "req_1" } });
  };
  return { calls, fetch };
}

describe("the owner's model, called from the device", () => {
  it("calls Anthropic with the owner's key, the system prompt and the refusal fallback", async () => {
    const p = provider(200, anthropicReply("Hello from the model."));
    const caller = createModelCaller({ provider: "anthropic", model: "claude-opus-5-5", apiKey: KEY }, { fetch: p.fetch });
    const text = await caller.complete({ system: "Be brief.", messages: [{ role: "user", content: "Hi" }] });
    expect(text).toBe("Hello from the model.");
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    expect(`${p.calls[0].headers.get("x-api-key") ?? ""} ${p.calls[0].headers.get("authorization") ?? ""}`).toContain(KEY);
    expect(p.calls[0].headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(p.calls[0].headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(p.calls[0].body).toMatchObject({ model: "claude-opus-5-5", system: "Be brief.", fallbacks: "default", messages: [{ role: "user", content: "Hi" }] });
  });

  it("sends no fallback for a model that does not take one", async () => {
    const p = provider(200, anthropicReply("ok"));
    await createModelCaller({ provider: "anthropic", model: "claude-haiku-5-5", apiKey: KEY }, { fetch: p.fetch }).complete({ system: "s", messages: [{ role: "user", content: "q" }] });
    expect(p.calls[0].body.fallbacks).toBeUndefined();
    expect(p.calls[0].headers.get("anthropic-beta")).toBeNull();
  });

  it("turns refusals, empty answers and rejected keys into plain errors", async () => {
    const run = (status: number, body: unknown) =>
      createModelCaller({ provider: "anthropic", model: "claude-opus-5-5", apiKey: KEY }, { fetch: provider(status, body).fetch }).complete({
        system: "s",
        messages: [{ role: "user", content: "q" }],
      });
    await expect(run(200, anthropicReply("", "refusal"))).rejects.toMatchObject({ code: "refused" });
    await expect(run(200, anthropicReply(""))).rejects.toMatchObject({ code: "empty" });
    await expect(run(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })).rejects.toMatchObject({ code: "auth" });
    await expect(run(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } })).rejects.toBeInstanceOf(ModelError);
  });

  it("calls OpenAI with the owner's key when that provider is chosen", async () => {
    const p = provider(200, { choices: [{ message: { content: "From the other provider." } }] });
    const caller = createModelCaller({ provider: "openai", model: "gpt-5", apiKey: "sk-openai-1234567890" }, { fetch: p.fetch });
    expect(await caller.complete({ system: "Sys", messages: [{ role: "user", content: "Q" }] })).toBe("From the other provider.");
    expect(p.calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(p.calls[0].headers.get("authorization")).toBe("Bearer sk-openai-1234567890");
    expect(p.calls[0].body.messages).toEqual([
      { role: "system", content: "Sys" },
      { role: "user", content: "Q" },
    ]);
    const denied = createModelCaller({ provider: "openai", model: "gpt-5", apiKey: "x" }, { fetch: provider(401, {}).fetch });
    await expect(denied.complete({ system: "s", messages: [] })).rejects.toMatchObject({ code: "auth" });
  });

  it("cleans settings and masks keys", () => {
    expect(cleanModelSettings({ provider: "anthropic", apiKey: ` ${KEY} ` })).toEqual({ provider: "anthropic", model: "claude-opus-5-5", apiKey: KEY });
    expect(cleanModelSettings({ provider: "openai", model: "bad model!", apiKey: "k" })?.model).toBe("gpt-5");
    expect(cleanModelSettings({ provider: "other", apiKey: "k" })).toBeNull();
    expect(cleanModelSettings({ provider: "anthropic", apiKey: "" })).toBeNull();
    expect(maskKey(KEY)).toBe("sk-ant-...cdef");
    expect(maskKey(KEY)).not.toContain("0123456789");
  });
});

describe("Raeto, one key for every model", () => {
  const RKEY = "rk_test_0123456789abcdef";
  function raeto(status: number, body: unknown, headers: Record<string, string> = {}) {
    const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    };
    return { calls, fetch };
  }
  const reply = (text: string) => ({ choices: [{ message: { role: "assistant", content: text } }] });

  it("calls Raeto with the owner's key and reads the model it picked and the cost", async () => {
    const p = raeto(200, reply("Hello through Raeto."), { "x-raeto-model": "deepseek/deepseek-v4", "x-raeto-cost": "0.000412" });
    const caller = createModelCaller({ provider: "raeto", model: "raeto/auto", apiKey: RKEY }, { fetch: p.fetch });
    expect(caller.lastRoute ?? null).toBeNull();
    const text = await caller.complete({ system: "Be brief.", messages: [{ role: "user", content: "Hi" }], maxTokens: 500 });
    expect(text).toBe("Hello through Raeto.");
    expect(p.calls[0].url).toBe("https://api.raeto.cc/v1/chat/completions");
    expect(p.calls[0].headers.get("authorization")).toBe(`Bearer ${RKEY}`);
    expect(p.calls[0].body).toMatchObject({ model: "raeto/auto", max_tokens: 500, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }] });
    expect(p.calls[0].body.max_completion_tokens).toBeUndefined();
    expect(caller.lastRoute).toEqual({ model: "deepseek/deepseek-v4", costUsd: 0.000412 });
  });

  it("falls back to the body, then to the model asked, when headers are missing", async () => {
    const fromBody = createModelCaller({ provider: "raeto", model: "raeto/auto", apiKey: RKEY }, { fetch: raeto(200, { ...reply("ok"), raeto: { model: "qwen/qwen3", cost_usd: 0.0002 } }).fetch });
    await fromBody.complete({ system: "s", messages: [{ role: "user", content: "q" }] });
    expect(fromBody.lastRoute).toEqual({ model: "qwen/qwen3", costUsd: 0.0002 });
    const bare = createModelCaller({ provider: "raeto", model: "raeto/auto:cheap", apiKey: RKEY }, { fetch: raeto(200, reply("ok")).fetch });
    await bare.complete({ system: "s", messages: [{ role: "user", content: "q" }] });
    expect(bare.lastRoute).toEqual({ model: "raeto/auto:cheap", costUsd: null });
  });

  it("says plainly when the Raeto balance is used up or the key is wrong", async () => {
    const run = (status: number) =>
      createModelCaller({ provider: "raeto", model: "raeto/auto", apiKey: RKEY }, { fetch: raeto(status, { error: { message: "x" } }).fetch }).complete({ system: "s", messages: [{ role: "user", content: "q" }] });
    await expect(run(402)).rejects.toMatchObject({ code: "balance" });
    await expect(run(401)).rejects.toMatchObject({ code: "auth" });
    await expect(run(429)).rejects.toMatchObject({ code: "rate" });
  });

  it("keeps Raeto settings and defaults to raeto/auto", () => {
    expect(cleanModelSettings({ provider: "raeto", apiKey: ` ${RKEY} ` })).toEqual({ provider: "raeto", model: "raeto/auto", apiKey: RKEY });
    expect(cleanModelSettings({ provider: "raeto", model: "raeto/auto:reason", apiKey: RKEY })?.model).toBe("raeto/auto:reason");
  });

  it("leaves OpenAI and Anthropic calls without a route", async () => {
    const caller = createModelCaller({ provider: "openai", model: "gpt-5", apiKey: "sk-test-0123456789abcdef" }, { fetch: raeto(200, reply("ok"), { "x-raeto-model": "nope" }).fetch });
    await caller.complete({ system: "s", messages: [{ role: "user", content: "q" }] });
    expect(caller.lastRoute ?? null).toBeNull();
  });
});
