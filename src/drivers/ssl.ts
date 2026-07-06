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
 * Certificate verification is ON by default; it is only disabled when the user
 * explicitly ticks "allow self-signed" (`allowInvalidCert`). A supplied CA is
 * loaded and used for verification.
 */
export function buildTls(config: ConnectionConfig): TlsOptions | undefined {
  if (!config.ssl) {
    return undefined;
  }
  const tls: TlsOptions = { rejectUnauthorized: !config.allowInvalidCert };
  if (config.sslCA) {
    tls.ca = fs.readFileSync(config.sslCA);
  }
  if (config.sslCert) {
    tls.cert = fs.readFileSync(config.sslCert);
  }
  if (config.sslKey) {
    tls.key = fs.readFileSync(config.sslKey);
  }
  return tls;
}
