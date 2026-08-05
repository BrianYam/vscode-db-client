/**
 * BYOK AI provider layer. Mirrors the Driver architecture: callers (query panel,
 * settings) are written against AiProvider only — they never speak a vendor's
 * wire protocol directly. Two adapters cover the market: `anthropic` (Messages
 * API) and `openai-compat` (OpenAI-style /chat/completions, which OpenAI, Groq,
 * DeepSeek, Mistral, Gemini's compat endpoint, OpenRouter, Ollama and LM Studio
 * all speak). No vendor SDKs — each protocol is a single fetch POST, and SDKs
 * would cost hundreds of KB against the "lightweight" pitch.
 */

export type AiProviderKind = "anthropic" | "openai-compat";

export interface AiProviderConfig {
  /** Stable id — keys SecretStorage (`ai:<providerId>`) and the usage ledger. */
  providerId: string;
  kind: AiProviderKind;
  /** Protocol root, e.g. "https://api.openai.com/v1". Editable for the long tail. */
  baseUrl: string;
  model: string;
}

export interface AiRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface AiResult {
  text: string;
  /** Exact counts from the response body — the usage ledger's source of truth. */
  inputTokens: number;
  outputTokens: number;
  /** Model as reported by the server, which may differ from the one requested. */
  model: string;
}

export interface AiProvider {
  readonly config: AiProviderConfig;
  complete(req: AiRequest, apiKey: string): Promise<AiResult>;
}

/** Injectable fetch so adapters are unit-testable without a network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** A provider failure with a message safe to show the user as-is. */
export class AiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AiError";
  }
}

/**
 * Map an HTTP failure to a human-readable message. Raw provider JSON never
 * reaches the UI; the body is only mined for the vendor's own error text.
 */
export function normalizeHttpError(status: number, host: string, bodyText: string): AiError {
  const detail = extractErrorDetail(bodyText);
  const suffix = detail ? ` (${detail})` : "";
  if (status === 401 || status === 403) {
    return new AiError(`API key was rejected by ${host}${suffix}`, status);
  }
  if (status === 404) {
    return new AiError(`Endpoint not found at ${host} — check the base URL${suffix}`, status);
  }
  if (status === 429) {
    return new AiError(`Rate limited by ${host} — try again shortly${suffix}`, status);
  }
  if (status >= 500) {
    return new AiError(`${host} returned a server error (HTTP ${status})${suffix}`, status);
  }
  return new AiError(`${host} returned HTTP ${status}${suffix}`, status);
}

/** Network-level failure (DNS, refused, offline) — no status code exists. */
export function normalizeNetworkError(host: string, err: unknown): AiError {
  const msg = err instanceof Error ? err.message : String(err);
  return new AiError(`Could not reach ${host} — ${msg}`);
}

/** Both protocols nest their message under { error: { message } }. Best effort. */
function extractErrorDetail(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText);
    const msg = parsed?.error?.message ?? parsed?.message;
    if (typeof msg === "string" && msg.length > 0) {
      return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
    }
  } catch {
    // Body wasn't JSON — an HTML error page adds nothing readable.
  }
  return "";
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Local endpoints (Ollama, LM Studio) keep everything on the machine, so the
 * consent gate shows a lighter notice for them.
 */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}
