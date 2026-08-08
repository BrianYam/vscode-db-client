import type * as vscode from "vscode";
import type { AiProviderConfig, AiProviderKind } from "./AiProvider";
import { isLocalBaseUrl } from "./AiProvider";
import { presetById } from "./registry";

export const AI_SETTINGS_KEY = "openDbClient.ai";
const SETTINGS_KEY = AI_SETTINGS_KEY;
// Same config/secret split as ConnectionStore: the key never touches globalState.
const secretKey = (providerId: string) => `openDbClient.aiKey.${providerId}`;

/**
 * What the form last held for one provider. Keys already live per provider in
 * SecretStorage; without this the endpoint config did not, so switching preset
 * and back reset the model to the preset default and discarded a custom base URL.
 */
export interface AiProviderMemory {
  baseUrl?: string;
  model?: string;
  litellmProvider?: string;
}

export interface AiSettings {
  providerId: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  /** Last-saved form values per providerId, so switching preset restores them. */
  perProvider: Record<string, AiProviderMemory>;
  /**
   * Which LiteLLM provider a "custom" endpoint's models should be priced
   * against (M29 D3). Empty = no LiteLLM fallback for custom, so unpriced
   * models honestly show "—" rather than borrowing an unrelated host's price.
   * Presets carry their own mapping in registry.ts; this only covers custom.
   */
  litellmProvider: string;
  /** First-use consent to send prompt + schema names to the provider. Revocable. */
  consentGiven: boolean;
  /** Connection ids where AI is switched off (regulated databases). */
  disabledConnections: string[];
}

const DEFAULTS: AiSettings = {
  providerId: "",
  kind: "openai-compat",
  baseUrl: "",
  model: "",
  perProvider: {},
  litellmProvider: "",
  consentGiven: false,
  disabledConnections: [],
};

/**
 * Fill in the active provider's own memory entry when it has none.
 *
 * Settings saved before per-provider memory existed carry only one endpoint
 * triple; without this seed the first switch to another preset and back would
 * "forget" a model the user had, in fact, saved. Pure so it can be tested
 * without the VS Code API.
 */
export function withProviderMemory(settings: AiSettings): AiSettings {
  const { providerId, perProvider } = settings;
  if (!providerId || perProvider[providerId]) {
    return settings;
  }
  return {
    ...settings,
    perProvider: {
      ...perProvider,
      [providerId]: {
        baseUrl: settings.baseUrl,
        model: settings.model,
        litellmProvider: settings.litellmProvider,
      },
    },
  };
}

/** Persists AI provider settings in globalState and the API key in SecretStorage. */
export class AiStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  get(): AiSettings {
    return withProviderMemory({
      ...DEFAULTS,
      ...this.ctx.globalState.get<Partial<AiSettings>>(SETTINGS_KEY, {}),
    });
  }

  async update(patch: Partial<AiSettings>): Promise<void> {
    await this.ctx.globalState.update(SETTINGS_KEY, { ...this.get(), ...patch });
  }

  getKey(providerId: string): Promise<string | undefined> {
    return Promise.resolve(this.ctx.secrets.get(secretKey(providerId)));
  }

  async setKey(providerId: string, key: string): Promise<void> {
    if (key) {
      await this.ctx.secrets.store(secretKey(providerId), key);
    } else {
      await this.ctx.secrets.delete(secretKey(providerId));
    }
  }

  /**
   * A provider is usable when base URL + model are set and a key exists — or
   * the endpoint doesn't need one (Ollama, other local servers).
   */
  async isConfigured(): Promise<boolean> {
    const s = this.get();
    if (!s.baseUrl || !s.model) {
      return false;
    }
    const preset = presetById(s.providerId);
    const needsKey = preset ? preset.needsKey : !isLocalBaseUrl(s.baseUrl);
    if (!needsKey) {
      return true;
    }
    return !!(await this.getKey(s.providerId));
  }

  providerConfig(): AiProviderConfig {
    const s = this.get();
    return { providerId: s.providerId, kind: s.kind, baseUrl: s.baseUrl, model: s.model };
  }

  aiEnabledFor(connId: string): boolean {
    return !this.get().disabledConnections.includes(connId);
  }

  async setAiEnabledFor(connId: string, enabled: boolean): Promise<void> {
    const list = this.get().disabledConnections.filter((id) => id !== connId);
    if (!enabled) {
      list.push(connId);
    }
    await this.update({ disabledConnections: list });
  }

  /** Purge settings and every stored key (Reset All Data). Best-effort on secrets. */
  async deleteAll(knownProviderIds: string[]): Promise<void> {
    await Promise.allSettled(knownProviderIds.map((id) => this.ctx.secrets.delete(secretKey(id))));
    await this.ctx.globalState.update(SETTINGS_KEY, undefined);
  }
}
