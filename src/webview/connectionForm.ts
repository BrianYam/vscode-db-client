import * as vscode from "vscode";
import { ConnectionConfig, DatabaseType, DEFAULT_PORTS } from "../connections/types";
import { newId } from "../connections/store";

interface FormResult {
  config: ConnectionConfig;
  password?: string;
}

/**
 * Collects a connection via a sequence of native input boxes. Passing `existing`
 * pre-fills the values for editing. Returns undefined if the user cancels.
 */
export async function promptForConnection(
  existing?: ConnectionConfig
): Promise<FormResult | undefined> {
  const type = await pickType(existing?.type);
  if (!type) {
    return undefined;
  }

  const name = await input("Connection name", existing?.name ?? "", (v) =>
    v.trim() ? undefined : "Name is required"
  );
  if (name === undefined) {
    return undefined;
  }

  const base: ConnectionConfig = {
    id: existing?.id ?? newId(),
    type,
    name: name.trim(),
  };

  if (type === "sqlite") {
    const filePath = await input("SQLite file path", existing?.filePath ?? "", (v) =>
      v.trim() ? undefined : "File path is required"
    );
    if (filePath === undefined) {
      return undefined;
    }
    base.filePath = filePath.trim();
    return { config: base };
  }

  // Network engines: host / port / user / password (+ db).
  const host = await input("Host", existing?.host ?? "127.0.0.1");
  if (host === undefined) {
    return undefined;
  }
  const portStr = await input(
    "Port",
    String(existing?.port ?? DEFAULT_PORTS[type]),
    (v) => (/^\d+$/.test(v.trim()) ? undefined : "Port must be a number")
  );
  if (portStr === undefined) {
    return undefined;
  }
  const username = await input("Username", existing?.username ?? "");
  if (username === undefined) {
    return undefined;
  }
  const password = await vscode.window.showInputBox({
    prompt: "Password (leave blank to keep existing / none)",
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) {
    return undefined;
  }

  base.host = host.trim();
  base.port = parseInt(portStr, 10);
  base.username = username.trim();

  if (type === "redis") {
    const dbStr = await input("Redis DB index", String(existing?.redisDb ?? 0), (v) =>
      /^\d+$/.test(v.trim()) ? undefined : "Must be a number"
    );
    if (dbStr === undefined) {
      return undefined;
    }
    base.redisDb = parseInt(dbStr, 10);
  } else {
    const database = await input("Database (optional)", existing?.database ?? "");
    if (database === undefined) {
      return undefined;
    }
    base.database = database.trim();
  }

  return { config: base, password: password === "" ? undefined : password };
}

async function pickType(current?: DatabaseType): Promise<DatabaseType | undefined> {
  const items: Array<vscode.QuickPickItem & { value: DatabaseType }> = [
    { label: "PostgreSQL", value: "postgres" },
    { label: "MySQL / MariaDB", value: "mysql" },
    { label: "SQLite", value: "sqlite" },
    { label: "Redis", value: "redis" },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "Database type",
    placeHolder: current ? `Current: ${current}` : "Select a database engine",
  });
  return picked?.value;
}

async function input(
  prompt: string,
  value: string,
  validate?: (v: string) => string | undefined
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    value,
    ignoreFocusOut: true,
    validateInput: validate,
  });
}
