import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { Client, ConnectConfig } from "ssh2";
import { ConnectionConfig, DEFAULT_PORTS } from "./types";
import { csTarget, csRewriteHostPort } from "./connString";

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
  secrets: SshSecrets
): Promise<{ tunnel: SshTunnel; effectiveConfig: ConnectionConfig }> {
  const usingCS = !!(config.useConnectionString && config.connectionString);
  let targetHost: string;
  let targetPort: number;

  if (usingCS) {
    try {
      const t = csTarget(config.connectionString!, DEFAULT_PORTS[config.type]);
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

  const effectiveConfig: ConnectionConfig = usingCS
    ? { ...config, connectionString: csRewriteHostPort(config.connectionString!, local.host, local.port) }
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
    private readonly targetPort: number
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
    this.server = net.createServer((sock) => {
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
        }
      );
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = this.server.address();
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
    if ((auth === "key" || auth === "auto") && this.config.sshPrivateKeyPath) {
      cfg.privateKey = fs.readFileSync(expandHome(this.config.sshPrivateKeyPath));
      if (this.secrets.sshPassphrase) {
        cfg.passphrase = this.secrets.sshPassphrase;
      }
    }
    if ((auth === "password" || auth === "auto") && this.secrets.sshPassword) {
      cfg.password = this.secrets.sshPassword;
    }
    return cfg;
  }

  close(): void {
    this.server?.close();
    this.client?.end();
    this.server = undefined;
    this.client = undefined;
  }
}
