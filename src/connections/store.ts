import * as vscode from "vscode";
import { ConnectionConfig } from "./types";

const KEY = "openDbClient.connections";
const secretKey = (id: string) => `openDbClient.password.${id}`;
const sshPwKey = (id: string) => `openDbClient.sshPassword.${id}`;
const sshPassphraseKey = (id: string) => `openDbClient.sshPassphrase.${id}`;

/** Secret values kept out of globalState. */
export interface Secrets {
  password?: string;
  sshPassword?: string;
  sshPassphrase?: string;
}

/**
 * Persists connection configs in globalState and passwords in SecretStorage.
 * There is intentionally NO connection-count limit — that paywall is the whole
 * reason this extension exists.
 */
export class ConnectionStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  all(): ConnectionConfig[] {
    return this.ctx.globalState.get<ConnectionConfig[]>(KEY, []).map(upcast);
  }

  get(id: string): ConnectionConfig | undefined {
    return this.all().find((c) => c.id === id);
  }

  async save(config: ConnectionConfig, secrets: Secrets = {}): Promise<void> {
    const list = this.all().filter((c) => c.id !== config.id);
    list.push({ ...config, schemaVersion: CURRENT_SCHEMA_VERSION });
    await this.ctx.globalState.update(KEY, list);
    await this.storeSecret(secretKey(config.id), secrets.password);
    await this.storeSecret(sshPwKey(config.id), secrets.sshPassword);
    await this.storeSecret(sshPassphraseKey(config.id), secrets.sshPassphrase);
  }

  private async storeSecret(key: string, value?: string): Promise<void> {
    if (value !== undefined && value !== "") {
      await this.ctx.secrets.store(key, value);
    }
  }

  /** Move the dragged connections so they sit just before `targetId` (or last). */
  async reorder(draggedIds: string[], targetId?: string): Promise<void> {
    const list = this.all();
    const dragged = list.filter((c) => draggedIds.includes(c.id));
    if (!dragged.length) {
      return;
    }
    const rest = list.filter((c) => !draggedIds.includes(c.id));
    let insertAt = rest.length;
    if (targetId) {
      const idx = rest.findIndex((c) => c.id === targetId);
      if (idx >= 0) {
        insertAt = idx;
      }
    }
    rest.splice(insertAt, 0, ...dragged);
    await this.ctx.globalState.update(KEY, rest);
  }

  async delete(id: string): Promise<void> {
    const list = this.all().filter((c) => c.id !== id);
    await this.ctx.globalState.update(KEY, list);
    await this.ctx.secrets.delete(secretKey(id));
    await this.ctx.secrets.delete(sshPwKey(id));
    await this.ctx.secrets.delete(sshPassphraseKey(id));
  }

  getPassword(id: string): Promise<string | undefined> {
    return Promise.resolve(this.ctx.secrets.get(secretKey(id)));
  }

  getSshPassword(id: string): Promise<string | undefined> {
    return Promise.resolve(this.ctx.secrets.get(sshPwKey(id)));
  }

  getSshPassphrase(id: string): Promise<string | undefined> {
    return Promise.resolve(this.ctx.secrets.get(sshPassphraseKey(id)));
  }
}

/** Small helper: unique-ish id without external deps. */
export function newId(): string {
  return "c_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Upcast a persisted config to the current schema. Legacy records (no
 * schemaVersion) predate certificate verification being on by default, so an
 * SSL-enabled legacy connection is migrated to `allowInvalidCert: true` to
 * preserve its original behaviour — verification is not silently turned on
 * under an existing, working connection.
 */
function upcast(c: ConnectionConfig): ConnectionConfig {
  if (c.schemaVersion === undefined && c.ssl && c.allowInvalidCert === undefined) {
    return { ...c, allowInvalidCert: true };
  }
  return c;
}
