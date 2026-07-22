import type { ConnectionConfig } from "../connections/types";
import type { Driver } from "./Driver";
import { MySqlDriver } from "./mysql";
import { PostgresDriver } from "./postgres";
import { RedisDriver } from "./redis";
import { SqliteDriver } from "./sqlite";

/** Build the right driver for a connection config. */
export function createDriver(config: ConnectionConfig): Driver {
  switch (config.type) {
    case "postgres":
      return new PostgresDriver(config);
    case "mysql":
      return new MySqlDriver(config);
    case "sqlite":
      return new SqliteDriver(config);
    case "redis":
      return new RedisDriver(config);
    default:
      throw new Error(`Unsupported database type: ${(config as ConnectionConfig).type}`);
  }
}
