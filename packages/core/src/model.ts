// The owner's own language model, called from the owner's device.
//
// Sigil never holds a model key in readable form: the key is encrypted in the
// vault (see settings.ts) and opened only in the owner's browser or in the
// connector on the owner's machine. Calls go from there straight to the
// provider. The fetch function is injectable so tests never reach a network.
//
// Raeto (raeto.cc) is a third choice: one key for 400+ models, topped up with
// USDG on Robinhood Chain or by card. Its raeto/auto routes pick the cheapest
// model that can do each call, and every answer says which model wrote it and
// what it cost.

import Anthropic from "@anthropic-ai/sdk";

export type ModelProvider = "anthropic" | "openai" | "raeto";

export interface ModelSettings {
  provider: ModelProvider;
  /** The model id at the provider. */
  model: string;
  apiKey: string;
}

export const DEFAULT_MODELS: Record<ModelProvider, string> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-5",
  raeto: "raeto/auto",
};

export const PROVIDER_NAMES: Record<ModelProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  raeto: "Raeto",
};

/** Raeto's own routes: each picks the cheapest model that can do the call. Any model id Raeto lists works too. */
export const RAETO_MODELS = ["raeto/auto", "raeto/auto:cheap", "raeto/auto:fast", "raeto/auto:reason", "raeto/auto:long"] as const;

export const RAETO_BASE_URL = "https://api.raeto.cc/v1";

/** The addresses a model call goes to. The site's content security policy allows exactly these. */
export const MODEL_ORIGINS = ["https://api.anthropic.com", "https://api.openai.com", "https://api.raeto.cc"] as const;

export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  maxTokens?: number;
}

/** Which model a router actually used for the last answer, and what it cost in dollars when the router says. */
export interface ModelRoute {
  model: string;
  costUsd: number | null;
}

export interface ModelCaller {
  readonly provider: ModelProvider;
  readonly model: string;
  complete(req: ModelRequest): Promise<string>;
  /** Set after each answer by a router (Raeto): the model it picked and the cost. Null for a direct provider. */
  readonly lastRoute?: ModelRoute | null;
}

export type ModelErrorCode = "auth" | "rate" | "refused" | "network" | "provider" | "empty" | "balance";

export class ModelError extends Error {
  constructor(
    message: string,
    public code: ModelErrorCode,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CallerOptions {
  fetch?: FetchLike;
}

export function cleanModelSettings(value: unknown): ModelSettings | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const provider = v.provider === "openai" ? "openai" : v.provider === "anthropic" ? "anthropic" : v.provider === "raeto" ? "raeto" : null;
  const apiKey = typeof v.apiKey === "string" ? v.apiKey.trim() : "";
  if (!provider || !apiKey) return null;
  const model = typeof v.model === "string" && /^[A-Za-z0-9._:/-]{1,100}$/.test(v.model.trim()) ? v.model.trim() : DEFAULT_MODELS[provider];
  return { provider, model, apiKey: apiKey.slice(0, 400) };
}

/** Shows the start and end of a key so the owner can tell which one is saved. */
export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 12) return "saved";
  return `${k.slice(0, 7)}...${k.slice(-4)}`;
}

const MAX_TOKENS = 8000;

// Models that accept the provider's refusal fallback: a declined request is run
// again on a fallback model inside the same call instead of simply stopping.
const FALLBACK_MODELS = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

function anthropicCaller(settings: ModelSettings, opts: CallerOptions): ModelCaller {
  const client = new Anthropic({
    apiKey: settings.apiKey,
    // The call is made in the owner's own browser with the owner's own key, on purpose.
    dangerouslyAllowBrowser: true,
    maxRetries: 1,
    ...(opts.fetch ? { fetch: opts.fetch as never } : {}),
  });
  return {
    provider: "anthropic",
    model: settings.model,
    async complete(req) {
      const params = { model: settings.model, max_tokens: req.maxTokens ?? MAX_TOKENS, system: req.system, messages: req.messages };
      let message: { content: { type: string; text?: string }[]; stop_reason: string | null };
      try {
        message = FALLBACK_MODELS.has(settings.model)
          ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as never)
          : await client.messages.create(params);
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
          throw new ModelError("The model key was not accepted. Check it under AI self, Model.", "auth");
        }
        if (err instanceof Anthropic.RateLimitError) throw new ModelError("The model provider is busy or your key is over its limit. Try again in a moment.", "rate");
        if (err instanceof Anthropic.APIConnectionError) throw new ModelError("The model provider could not be reached.", "network");
        if (err instanceof Anthropic.APIError) throw new ModelError(`The model provider answered ${err.status ?? "with an error"}.`, "provider");
        throw new ModelError((err as Error).message || "The model call failed.", "provider");
      }
      if (message.stop_reason === "refusal") throw new ModelError("The model declined to answer.", "refused");
      const text = message.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("")
        .trim();
      if (!text) throw new ModelError("The model gave an empty answer.", "empty");
      return text;
    },
  };
}

type ChatReply = { choices?: { message?: { content?: string; refusal?: string | null } }[]; raeto?: { model?: unknown; cost_usd?: unknown } } | null;

/** OpenAI and Raeto speak the same chat format; Raeto adds the model it picked and the cost. */
function chatCaller(settings: ModelSettings, opts: CallerOptions): ModelCaller {
  const doFetch: FetchLike = opts.fetch ?? ((i, init) => fetch(i, init));
  const raeto = settings.provider === "raeto";
  const url = raeto ? `${RAETO_BASE_URL}/chat/completions` : "https://api.openai.com/v1/chat/completions";
  const caller = {
    provider: settings.provider,
    model: settings.model,
    lastRoute: null as ModelRoute | null,
    async complete(req: ModelRequest): Promise<string> {
      caller.lastRoute = null;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
          body: JSON.stringify({
            model: settings.model,
            ...(raeto ? { max_tokens: req.maxTokens ?? MAX_TOKENS } : { max_completion_tokens: req.maxTokens ?? MAX_TOKENS }),
            messages: [{ role: "system", content: req.system }, ...req.messages],
          }),
        });
      } catch {
        throw new ModelError("The model provider could not be reached.", "network");
      }
      if (res.status === 401 || res.status === 403) throw new ModelError("The model key was not accepted. Check it under AI self, Model.", "auth");
      if (raeto && res.status === 402) throw new ModelError("Your Raeto balance is used up. Top it up at raeto.cc and ask again.", "balance");
      if (res.status === 429) throw new ModelError("The model provider is busy or your key is over its limit. Try again in a moment.", "rate");
      if (!res.ok) throw new ModelError(`The model provider answered ${res.status}.`, "provider");
      const data = (await res.json().catch(() => null)) as ChatReply;
      const choice = data?.choices?.[0]?.message;
      if (choice?.refusal) throw new ModelError("The model declined to answer.", "refused");
      const text = (choice?.content ?? "").trim();
      if (!text) throw new ModelError("The model gave an empty answer.", "empty");
      if (raeto) {
        const picked = res.headers.get("x-raeto-model")?.trim() || (typeof data?.raeto?.model === "string" ? data.raeto.model : "") || settings.model;
        const cost = Number(res.headers.get("x-raeto-cost") ?? data?.raeto?.cost_usd ?? NaN);
        caller.lastRoute = { model: picked.slice(0, 100), costUsd: Number.isFinite(cost) && cost >= 0 ? cost : null };
      }
      return text;
    },
  };
  return caller;
}

export function createModelCaller(settings: ModelSettings, opts: CallerOptions = {}): ModelCaller {
  return settings.provider === "anthropic" ? anthropicCaller(settings, opts) : chatCaller(settings, opts);
}
