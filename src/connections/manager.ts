import type { Driver } from "../drivers/Driver";
import { createDriver } from "../drivers/registry";
import { logError } from "../log";
import { withTimeout } from "../timeout";
import { openTunnelForConfig, type SshTunnel } from "./sshTunnel";
import type { ConnectionStore } from "./store";

// A connect can wedge *before* the driver ever becomes live — the SSH tunnel
// open or the driver's own connect() can hang with no server response. We cap
// the tunnel open (it had none) so a dead SSH host can't spin forever.
const TUNNEL_OPEN_TIMEOUT_MS = 15_000;

/** The half-built driver/tunnel of a connect that hasn't finished (or wedged). */
interface Pending {
  driver?: Driver;
  tunnel?: SshTunnel;
}

/** Owns live driver instances (and their SSH tunnels) and connects on demand. */
export class ConnectionManager {
  private live = new Map<string, Driver>();
  private tunnels = new Map<string, SshTunnel>();
  // In-flight connects. A stuck connection is *here*, not in `live`, so without
  // this map disposeAll() (and thus Stop All) could never reach it — the whole
  // reason a wedged spinner used to force a VS Code restart.
  private pending = new Map<string, Pending>();

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

    // Register the half-built connection up front so disposeAll() can tear it
    // down mid-flight (the "stuck spinner" state).
    const pend: Pending = {};
    this.pending.set(id, pend);
    try {
      let effectiveConfig = config;

      if (config.sshEnabled && config.type !== "sqlite") {
        const { tunnel, effectiveConfig: tunneled } = await withTimeout(
          openTunnelForConfig(config, {
            sshPassword: await this.store.getSshPassword(id),
            sshPassphrase: await this.store.getSshPassphrase(id),
          }),
          TUNNEL_OPEN_TIMEOUT_MS,
          "SSH tunnel",
        );
        pend.tunnel = tunnel;
        this.tunnels.set(id, tunnel);
        effectiveConfig = tunneled;
      }

      const driver = createDriver(effectiveConfig);
      pend.driver = driver;
      const password = await this.store.getPassword(id);
      await driver.connect(password);
      this.live.set(id, driver);
      return driver;
    } catch (err) {
      logError(`connect:${config.type}:${config.name}`, err);
      // Best-effort teardown of whatever we built. Stop All may have already
      // disposed these concurrently, so guard against a double dispose/close.
      await pend.driver?.dispose().catch(() => undefined);
      const t = this.tunnels.get(id);
      if (t) {
        try {
          t.close();
        } catch {
          /* ignore: already closed by a concurrent Stop All */
        }
        this.tunnels.delete(id);
      }
      throw err;
    } finally {
      this.pending.delete(id);
    }
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
    // Best-effort teardown of EVERYTHING — live drivers, in-flight (pending)
    // connects that never became live, and every tunnel — attempting each
    // dispose/close even if some reject, so one misbehaving driver or tunnel
    // can't leave the rest live. This is what "Stop All" and deactivate() call,
    // so a wedged mid-connect node clears here instead of forcing a restart.
    const pend = [...this.pending.values()];
    this.pending.clear();

    const drivers = [...this.live.values()];
    this.live.clear();
    for (const p of pend) {
      if (p.driver) {
        drivers.push(p.driver);
      }
    }
    await Promise.allSettled(drivers.map((d) => d.dispose()));

    const tunnels = [...this.tunnels.values()];
    this.tunnels.clear();
    for (const p of pend) {
      // A pending tunnel is usually already in `this.tunnels`; only add the ones
      // that aren't, to avoid closing the same tunnel twice.
      if (p.tunnel && !tunnels.includes(p.tunnel)) {
        tunnels.push(p.tunnel);
      }
    }
    for (const t of tunnels) {
      try {
        t.close();
      } catch {
        /* ignore: a failing close must not skip the remaining tunnels */
      }
    }
  }
}
