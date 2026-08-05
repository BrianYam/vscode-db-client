import type { AiProvider, AiProviderConfig, AiProviderKind, FetchLike } from "./AiProvider";
import { AnthropicProvider } from "./anthropic";
import { OpenAiCompatProvider } from "./openaiCompat";

/**
 * The one place `kind` is switched on — the AI counterpart of
 * drivers/registry.ts#createDriver. Adding a protocol means one adapter file
 * plus a case here; nothing else learns it exists.
 */
export function createAiProvider(config: AiProviderConfig, fetchImpl?: FetchLike): AiProvider {
  switch (config.kind) {
    case "anthropic":
      return new AnthropicProvider(config, fetchImpl);
    case "openai-compat":
      return new OpenAiCompatProvider(config, fetchImpl);
    default: {
      const never: never = config.kind;
      throw new Error(`Unknown AI provider kind: ${never}`);
    }
  }
}

/**
 * Presets are data, not adapters. `defaultModel` seeds a free-text field — no
 * hardcoded model list to go stale; users type any model their provider serves.
 */
export interface AiPreset {
  id: string;
  label: string;
  kind: AiProviderKind;
  baseUrl: string;
  defaultModel: string;
  /** Whether the endpoint requires an API key at all (Ollama does not). */
  needsKey: boolean;
}

export const AI_PRESETS: AiPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-5",
    needsKey: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai-compat",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5-mini",
    needsKey: true,
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    kind: "openai-compat",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1",
    needsKey: false,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4.5",
    needsKey: true,
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    kind: "openai-compat",
    baseUrl: "",
    defaultModel: "",
    needsKey: true,
  },
];

export function presetById(id: string): AiPreset | undefined {
  return AI_PRESETS.find((p) => p.id === id);
}
