import { ConnectionConfig } from "../connections/types";
import { Driver } from "./Driver";
import { PostgresDriver } from "./postgres";
import { MySqlDriver } from "./mysql";
import { SqliteDriver } from "./sqlite";
import { RedisDriver } from "./redis";

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
