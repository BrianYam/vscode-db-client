import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Client, type ConnectConfig, utils as sshUtils } from "ssh2";
import { csRewriteHostPort, csTarget } from "./connString";
import { type ConnectionConfig, DEFAULT_PORTS } from "./types";

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Opens an SSH tunnel for a config (field-based OR connection-string) and returns
 * both the tunnel and a config rewritten to point at the local forwarded port.
 * For connection strings, the host/port are parsed out and the string is rewritten.
 */
export async function openTunnelForConfig(
  config: ConnectionConfig,
  secrets: SshSecrets,
): Promise<{ tunnel: SshTunnel; effectiveConfig: ConnectionConfig }> {
  const connString = config.useConnectionString ? config.connectionString : undefined;
  let targetHost: string;
  let targetPort: number;

  if (connString) {
    try {
      const t = csTarget(connString, DEFAULT_PORTS[config.type]);
      targetHost = t.host;
      targetPort = t.port;
    } catch {
      throw new Error("Invalid connection string — cannot parse host for SSH tunnel");
    }
  } else {
    targetHost = config.host || "127.0.0.1";
    targetPort = config.port ?? DEFAULT_PORTS[config.type];
  }

  const tunnel = new SshTunnel(config, secrets, targetHost, targetPort);
  const local = await tunnel.open();

  const effectiveConfig: ConnectionConfig = connString
    ? {
        ...config,
        connectionString: csRewriteHostPort(connString, local.host, local.port),
      }
    : { ...config, host: local.host, port: local.port };
  return { tunnel, effectiveConfig };
}

export interface SshSecrets {
  sshPassword?: string;
  sshPassphrase?: string;
}

/**
 * Opens an SSH connection and a local TCP forward to a remote database host.
 * Drivers then connect to 127.0.0.1:<localPort> as if the DB were local.
 */
export class SshTunnel {
  private client?: Client;
  private server?: net.Server;
  localPort = 0;

  constructor(
    private readonly config: ConnectionConfig,
    private readonly secrets: SshSecrets,
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  async open(): Promise<{ host: string; port: number }> {
    const client = new Client();
    this.client = client;
    const connectCfg = this.buildConnectConfig();

    await new Promise<void>((resolve, reject) => {
      const timeout = this.config.sshConnectTimeout ?? 5000;
      client
        .on("ready", () => resolve())
        .on("error", (err) => reject(new Error(`SSH: ${err.message}`)))
        .connect({ ...connectCfg, readyTimeout: timeout });
    });

    // Local forwarding server: each inbound socket is forwarded over SSH.
    const server = net.createServer((sock) => {
      client.forwardOut(
        sock.remoteAddress ?? "127.0.0.1",
        sock.remotePort ?? 0,
        this.targetHost,
        this.targetPort,
        (err, stream) => {
          if (err) {
            sock.destroy();
            return;
          }
          sock.pipe(stream).pipe(sock);
        },
      );
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Failed to allocate local tunnel port");
    }
    this.localPort = addr.port;
    return { host: "127.0.0.1", port: this.localPort };
  }

  private buildConnectConfig(): ConnectConfig {
    const cfg: ConnectConfig = {
      host: this.config.sshHost,
      port: this.config.sshPort ?? 22,
      username: this.config.sshUsername,
    };
    const auth = this.config.sshAuth ?? "auto";
    const agentSock = process.env.SSH_AUTH_SOCK;

    if ((auth === "agent" || auth === "auto") && agentSock) {
      cfg.agent = agentSock;
    }
    if (auth === "key" || auth === "auto") {
      const key = this.resolvePrivateKey();
      if (key) {
        cfg.privateKey = key;
        if (this.secrets.sshPassphrase) {
          cfg.passphrase = this.secrets.sshPassphrase;
        }
      }
    }
    if ((auth === "password" || auth === "auto") && this.secrets.sshPassword) {
      cfg.password = this.secrets.sshPassword;
    }
    return cfg;
  }

  /**
   * The private key to authenticate with. An explicit path always wins; with none
   * given (the common "Auto" case), fall back to the first default identity file
   * that parses — `ssh2`, unlike the `ssh` CLI, never reads `~/.ssh/id_*` on its
   * own, so "Auto" would otherwise only ever try the agent and fail on machines
   * whose key isn't loaded (`ssh-add`). A default key is only offered if it parses
   * with the given passphrase, so an encrypted key with no passphrase is skipped
   * (rather than making ssh2 throw before it can try the agent or password).
   */
  private resolvePrivateKey(): Buffer | undefined {
    const explicit = this.config.sshPrivateKeyPath;
    if (explicit) {
      return fs.readFileSync(expandHome(explicit));
    }
    const passphrase = this.secrets.sshPassphrase;
    for (const name of ["id_ed25519", "id_rsa", "id_ecdsa"]) {
      const p = path.join(os.homedir(), ".ssh", name);
      let data: Buffer;
      try {
        data = fs.readFileSync(p);
      } catch {
        continue; // no such default key on this machine
      }
      if (!(sshUtils.parseKey(data, passphrase) instanceof Error)) {
        return data;
      }
    }
    return undefined;
  }

  close(): void {
    this.server?.close();
    this.client?.end();
    this.server = undefined;
    this.client = undefined;
  }
}
