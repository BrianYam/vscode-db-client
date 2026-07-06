import { ConnectionStore } from "./store";
import { createDriver } from "../drivers/registry";
import { Driver } from "../drivers/Driver";

/** Owns live driver instances and connects them on demand. */
export class ConnectionManager {
  private live = new Map<string, Driver>();

  constructor(private readonly store: ConnectionStore) {}

  /** Get a connected driver for `id`, connecting (with stored password) if needed. */
  async getDriver(id: string): Promise<Driver> {
    const existing = this.live.get(id);
    if (existing) {
      return existing;
    }
    const config = this.store.get(id);
    if (!config) {
      throw new Error("Connection not found");
    }
    const driver = createDriver(config);
    const password = await this.store.getPassword(id);
    await driver.connect(password);
    this.live.set(id, driver);
    return driver;
  }

  isConnected(id: string): boolean {
    return this.live.has(id);
  }

  async disconnect(id: string): Promise<void> {
    const d = this.live.get(id);
    if (d) {
      await d.dispose();
      this.live.delete(id);
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.live.values()].map((d) => d.dispose()));
    this.live.clear();
  }
}
