import type * as vscode from "vscode";
import type { AiProviderConfig, AiProviderKind } from "./AiProvider";
import { isLocalBaseUrl } from "./AiProvider";
import { presetById } from "./registry";

const SETTINGS_KEY = "openDbClient.ai";
// Same config/secret split as ConnectionStore: the key never touches globalState.
const secretKey = (providerId: string) => `openDbClient.aiKey.${providerId}`;

export interface AiSettings {
  providerId: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
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
  consentGiven: false,
  disabledConnections: [],
};

/** Persists AI provider settings in globalState and the API key in SecretStorage. */
export class AiStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  get(): AiSettings {
    return { ...DEFAULTS, ...this.ctx.globalState.get<Partial<AiSettings>>(SETTINGS_KEY, {}) };
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
