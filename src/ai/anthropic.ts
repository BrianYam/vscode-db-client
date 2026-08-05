import {
  AiError,
  type AiModelInfo,
  type AiProvider,
  type AiProviderConfig,
  type AiRequest,
  type AiResult,
  type FetchLike,
  hostOf,
  normalizeHttpError,
  normalizeNetworkError,
} from "./AiProvider";

/** The few response fields we read, everything else ignored (and untrusted). */
interface MessagesResponse {
  model?: unknown;
  content?: Array<{ type?: unknown; text?: unknown }>;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

/**
 * Anthropic Messages API adapter. Differs from the OpenAI shape in endpoint,
 * headers (x-api-key + anthropic-version) and response layout, which is why it
 * gets its own file rather than a flag on the compat adapter.
 */
export class AnthropicProvider implements AiProvider {
  constructor(
    readonly config: AiProviderConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async complete(req: AiRequest, apiKey: string): Promise<AiResult> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/v1/messages`;
    const host = hostOf(this.config.baseUrl);
    const body = {
      model: this.config.model,
      // Required by the API, unlike OpenAI where it is optional.
      max_tokens: req.maxTokens ?? 2048,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    };

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw normalizeNetworkError(host, err);
    }
    const text = await res.text();
    if (!res.ok) {
      throw normalizeHttpError(res.status, host, text);
    }

    let parsed: MessagesResponse;
    try {
      parsed = JSON.parse(text) as MessagesResponse;
    } catch {
      throw new AiError(`${host} returned a non-JSON response`);
    }
    const block = Array.isArray(parsed?.content)
      ? parsed.content.find((b) => b?.type === "text")
      : undefined;
    if (typeof block?.text !== "string") {
      throw new AiError(`${host} returned no completion text`);
    }
    return {
      text: block.text,
      inputTokens: Number(parsed?.usage?.input_tokens ?? 0),
      outputTokens: Number(parsed?.usage?.output_tokens ?? 0),
      model: typeof parsed?.model === "string" ? parsed.model : this.config.model,
    };
  }

  async listModels(apiKey: string): Promise<AiModelInfo[]> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/v1/models?limit=1000`;
    const host = hostOf(this.config.baseUrl);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      });
    } catch (err) {
      throw normalizeNetworkError(host, err);
    }
    const text = await res.text();
    if (!res.ok) {
      throw normalizeHttpError(res.status, host, text);
    }
    let parsed: { data?: Array<{ id?: unknown }> };
    try {
      parsed = JSON.parse(text) as { data?: Array<{ id?: unknown }> };
    } catch {
      throw new AiError(`${host} returned a non-JSON response`);
    }
    // Anthropic's list carries no pricing — the settings layer annotates from
    // the local price table instead.
    const ids = (parsed.data ?? [])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === "string");
    return [...new Set(ids)]
      .sort()
      .reverse()
      .map((id) => ({ id }));
  }
}
