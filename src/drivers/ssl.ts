import * as fs from "fs";
import { ConnectionConfig } from "../connections/types";

export interface TlsOptions {
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  rejectUnauthorized: boolean;
}

/**
 * Build TLS options from a connection config. Returns undefined when SSL is off.
 * Providing a CA turns on certificate verification; without one we accept
 * self-signed certs (rejectUnauthorized: false), which is the common case for
 * quick access to cloud databases.
 */
export function buildTls(config: ConnectionConfig): TlsOptions | undefined {
  if (!config.ssl) {
    return undefined;
  }
  const tls: TlsOptions = { rejectUnauthorized: false };
  if (config.sslCA) {
    tls.ca = fs.readFileSync(config.sslCA);
    tls.rejectUnauthorized = true;
  }
  if (config.sslCert) {
    tls.cert = fs.readFileSync(config.sslCert);
  }
  if (config.sslKey) {
    tls.key = fs.readFileSync(config.sslKey);
  }
  return tls;
}
