import {
  AiError,
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
interface CompatResponse {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

/**
 * OpenAI-compatible /chat/completions adapter. One adapter covers OpenAI, Groq,
 * DeepSeek, Mistral, Gemini (compat endpoint), OpenRouter, Ollama and LM Studio
 * — the base URL is the only thing that differs.
 */
export class OpenAiCompatProvider implements AiProvider {
  constructor(
    readonly config: AiProviderConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async complete(req: AiRequest, apiKey: string): Promise<AiResult> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const host = hostOf(this.config.baseUrl);
    const headers: Record<string, string> = { "content-type": "application/json" };
    // Local servers (Ollama) take no key; sending an empty Bearer breaks some.
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    };
    if (req.maxTokens != null) {
      body.max_tokens = req.maxTokens;
    }

    const post = async (): Promise<Response> => {
      try {
        return await this.fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw normalizeNetworkError(host, err);
      }
    };

    let res = await post();
    let text = await res.text();
    // Newer OpenAI models renamed the cap to max_completion_tokens; the rest of
    // the compatible world (Ollama, Groq, OpenRouter, …) still expects
    // max_tokens. Retry once with the new name on that exact complaint instead
    // of making the user configure which generation their server speaks.
    if (
      !res.ok &&
      res.status === 400 &&
      req.maxTokens != null &&
      /max_completion_tokens/.test(text)
    ) {
      delete body.max_tokens;
      body.max_completion_tokens = req.maxTokens;
      res = await post();
      text = await res.text();
    }
    if (!res.ok) {
      throw normalizeHttpError(res.status, host, text);
    }

    let parsed: CompatResponse;
    try {
      parsed = JSON.parse(text) as CompatResponse;
    } catch {
      throw new AiError(`${host} returned a non-JSON response`);
    }
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new AiError(`${host} returned no completion text`);
    }
    return {
      text: content,
      inputTokens: Number(parsed?.usage?.prompt_tokens ?? 0),
      outputTokens: Number(parsed?.usage?.completion_tokens ?? 0),
      model: typeof parsed?.model === "string" ? parsed.model : this.config.model,
    };
  }
}
