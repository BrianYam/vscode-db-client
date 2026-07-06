import { ConnectionStore } from "./store";
import { createDriver } from "../drivers/registry";
import { Driver } from "../drivers/Driver";
import { SshTunnel, openTunnelForConfig } from "./sshTunnel";

/** Owns live driver instances (and their SSH tunnels) and connects on demand. */
export class ConnectionManager {
  private live = new Map<string, Driver>();
  private tunnels = new Map<string, SshTunnel>();

  constructor(private readonly store: ConnectionStore) {}

  /** Get a connected driver for `id`, connecting (with stored secrets) if needed. */
  async getDriver(id: string): Promise<Driver> {
    const existing = this.live.get(id);
    if (existing) {
      return existing;
    }
    const config = this.store.get(id);
    if (!config) {
      throw new Error("Connection not found");
    }

    let effectiveConfig = config;

    if (config.sshEnabled && config.type !== "sqlite") {
      const { tunnel, effectiveConfig: tunneled } = await openTunnelForConfig(config, {
        sshPassword: await this.store.getSshPassword(id),
        sshPassphrase: await this.store.getSshPassphrase(id),
      });
      this.tunnels.set(id, tunnel);
      effectiveConfig = tunneled;
    }

    const driver = createDriver(effectiveConfig);
    try {
      const password = await this.store.getPassword(id);
      await driver.connect(password);
    } catch (err) {
      this.tunnels.get(id)?.close();
      this.tunnels.delete(id);
      throw err;
    }
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
    const t = this.tunnels.get(id);
    if (t) {
      t.close();
      this.tunnels.delete(id);
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.live.values()].map((d) => d.dispose()));
    this.live.clear();
    this.tunnels.forEach((t) => t.close());
    this.tunnels.clear();
  }
}
