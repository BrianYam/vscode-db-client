import * as vscode from "vscode";
import { ConnectionConfig } from "./types";

const KEY = "openDbClient.connections";
const secretKey = (id: string) => `openDbClient.password.${id}`;

/**
 * Persists connection configs in globalState and passwords in SecretStorage.
 * There is intentionally NO connection-count limit — that paywall is the whole
 * reason this extension exists.
 */
export class ConnectionStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  all(): ConnectionConfig[] {
    return this.ctx.globalState.get<ConnectionConfig[]>(KEY, []);
  }

  get(id: string): ConnectionConfig | undefined {
    return this.all().find((c) => c.id === id);
  }

  async save(config: ConnectionConfig, password?: string): Promise<void> {
    const list = this.all().filter((c) => c.id !== config.id);
    list.push(config);
    await this.ctx.globalState.update(KEY, list);
    if (password !== undefined && password !== "") {
      await this.ctx.secrets.store(secretKey(config.id), password);
    }
  }

  async delete(id: string): Promise<void> {
    const list = this.all().filter((c) => c.id !== id);
    await this.ctx.globalState.update(KEY, list);
    await this.ctx.secrets.delete(secretKey(id));
  }

  getPassword(id: string): Promise<string | undefined> {
    return Promise.resolve(this.ctx.secrets.get(secretKey(id)));
  }
}

/** Small helper: unique-ish id without external deps. */
export function newId(): string {
  return "c_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
