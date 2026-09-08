import type { ConnectionConfig, DatabaseType } from "../connections/types";
import { AthenaDriver } from "./athena";
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
    case "athena":
      return new AthenaDriver(config);
    default:
      throw new Error(`Unsupported database type: ${(config as ConnectionConfig).type}`);
  }
}

/**
 * Which segment of a driver's tree path names the database that statements run
 * against. The path itself is opaque to everything outside the driver, so this
 * is the one place allowed to know its shape.
 *
 * Every engine puts the database first except Athena, where the Glue data
 * catalog sits one level ABOVE it: path[0] there is "AwsDataCatalog". Reading
 * it as the database made every schemaHints call ask Glue for a database of
 * that name — which is why AI Generate failed with "Database awsdatacatalog not
 * found" (or a glue:GetTables denial) while a fully qualified query still ran.
 *
 * SQLite has a single database and its path[0] is a table name, so it has none.
 */
export function databaseFromPath(
  type: DatabaseType | undefined,
  path: string[],
): string | undefined {
  if (type === "sqlite") {
    return undefined;
  }
  return type === "athena" ? path[1] : path[0];
}
