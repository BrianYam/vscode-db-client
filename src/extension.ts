import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ConnectionManager } from "./connections/manager";
import {
  buildExport,
  countEmbeddedCredentials,
  countSecrets,
  decryptBundle,
  encryptBundle,
  isEncryptedBundle,
  mergeConnections,
  parseImport,
} from "./connections/portability";
import { QueryStore } from "./connections/queryStore";
import { ConnectionStore, newId } from "./connections/store";
import { setSqliteWasmDir } from "./drivers/sqlite";
import { initLog, logError, logInfo } from "./log";
import { bindQueryDoc, registerSqlFeatures } from "./sqlFeatures";
import { DatabaseTreeProvider, type DbNode, splitQueryPath } from "./tree/DatabaseTreeProvider";
import { ConnectionFormPanel } from "./webview/connectionFormPanel";
import { QueryPanel } from "./webview/queryPanel";
import { SettingsPanel } from "./webview/settingsPanel";

const LAST_SEEN_VERSION_KEY = "openDbClient.lastSeenVersion";

type ExportMode = "redacted" | "encrypted" | "plaintext";

/**
 * The three export shapes, in increasing order of what they give away. Listed in
 * one picker so the trade-off is visible at the moment of choosing — the detail
 * lines are the whole point, not decoration.
 */
const EXPORT_MODES: Array<vscode.QuickPickItem & { mode: ExportMode }> = [
  {
    mode: "redacted",
    label: "$(shield) Without passwords",
    description: "safe to share",
    detail:
      "Servers, ports, users and options only. Passwords are left out, and any password inside a connection string is stripped.",
  },
  {
    mode: "encrypted",
    label: "$(lock) With passwords — encrypted",
    description: "needs a passphrase",
    detail:
      "Everything, including passwords and SSH secrets, sealed with a passphrase you choose. Lose the passphrase and the file is unrecoverable.",
  },
  {
    mode: "plaintext",
    label: "$(warning) With passwords — PLAIN TEXT",
    description: "readable by anyone",
    detail:
      "Everything, unencrypted. Only for a file you control and delete straight after. You will be asked to confirm.",
  },
];

export function activate(ctx: vscode.ExtensionContext): void {
  initLog(ctx);

  // Track the version we last activated under, so future features (What's New,
  // one-time upgrade migrations) can react to a fresh install or an upgrade.
  const version = ctx.extension.packageJSON.version;
  const lastSeen = ctx.globalState.get<string>(LAST_SEEN_VERSION_KEY);
  if (lastSeen !== version) {
    logInfo("activate", lastSeen ? `Upgraded ${lastSeen} → ${version}` : `First run at ${version}`);
    void ctx.globalState.update(LAST_SEEN_VERSION_KEY, version);
  }

  // sql.js needs to locate its .wasm file at runtime. It is bundled into dist/
  // by esbuild.js; fall back to node_modules for unbundled (F5 without bundle).
  setSqliteWasmDir(vscode.Uri.joinPath(ctx.extensionUri, "dist").fsPath);

  const store = new ConnectionStore(ctx);
  const manager = new ConnectionManager(store);
  const queries = new QueryStore(ctx.globalStorageUri);
  const tree = new DatabaseTreeProvider(store, manager, ctx.extensionUri, queries);
  registerSqlFeatures(ctx, queries, manager, store);

  ctx.subscriptions.push(
    vscode.window.createTreeView("openDbClient.connections", {
      treeDataProvider: tree,
      dragAndDropController: tree,
    }),
  );

  // VS Code command handlers have heterogeneous, per-command signatures, so the
  // wrapper mirrors registerCommand's own `(...args: any[]) => any` shape.
  // biome-ignore lint/suspicious/noExplicitAny: matches vscode.commands.registerCommand
  const reg = (id: string, fn: (...a: any[]) => any) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("openDbClient.refresh", () => tree.refresh());

  reg("openDbClient.settings", () => SettingsPanel.open(ctx));

  // Purge every trace of user data: live connections, stored secrets, saved
  // connection configs, and all saved query files. VS Code keeps all of this
  // after an uninstall, so this is the user's one-click "remove everything".
  reg("openDbClient.resetAllData", async () => {
    const choice = await vscode.window.showWarningMessage(
      "Remove ALL Open DB Client data? This deletes every saved connection, all stored passwords/SSH secrets, and all saved query files. This cannot be undone.",
      { modal: true },
      "Remove Everything",
    );
    if (choice !== "Remove Everything") {
      return;
    }
    // Best-effort purge: attempt every step, always refresh the tree afterward,
    // and report truthfully whether anything might remain.
    try {
      await manager.disposeAll();
      const { secretsFailed } = await store.deleteAll();
      await queries.deleteAll();
      if (secretsFailed > 0) {
        vscode.window.showWarningMessage(
          `Open DB Client: connections and query files were removed, but ${secretsFailed} stored secret(s) may still remain in the OS keychain.`,
        );
      } else {
        vscode.window.showInformationMessage("Open DB Client: all data removed.");
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `Open DB Client: reset failed — some data may remain. ${(err as Error).message}`,
      );
    } finally {
      tree.refresh();
    }
  });

  // Stop All: force-tear-down every connection — live AND in-flight — and
  // collapse the tree back to a clean state. The escape hatch for a wedged
  // spinner so the user never has to restart VS Code.
  reg("openDbClient.stopAll", async () => {
    await manager.disposeAll();
    tree.markAllDisconnected();
    vscode.window.setStatusBarMessage("Open DB Client: all connections stopped.", 3000);
  });

  reg("openDbClient.refreshNode", (node: DbNode) => tree.refresh(node));

  reg("openDbClient.connect", async (node: DbNode) => {
    try {
      await manager.getDriver(node.connectionId);
      tree.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Connect failed: ${(err as Error).message}`);
      tree.refresh();
    }
  });

  reg("openDbClient.disconnect", async (node: DbNode) => {
    await manager.disconnect(node.connectionId);
    tree.markDisconnected(node.connectionId);
  });

  reg("openDbClient.addConnection", () => {
    ConnectionFormPanel.open(ctx, store, manager, () => tree.refresh());
  });

  reg("openDbClient.editConnection", (node: DbNode) => {
    const existing = store.get(node.connectionId);
    if (!existing) {
      return;
    }
    ConnectionFormPanel.open(ctx, store, manager, () => tree.refresh(), existing);
  });

  reg("openDbClient.deleteConnection", async (node: DbNode) => {
    const existing = store.get(node.connectionId);
    if (!existing) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Delete connection "${existing.name}"?`,
      { modal: true },
      "Delete",
    );
    if (ok === "Delete") {
      await manager.disconnect(existing.id);
      await store.delete(existing.id);
      tree.refresh();
    }
  });

  // ---------------------------------------------------------------- portability
  // Three export shapes, offered together in one picker so the safe one is what
  // you see first and the cost of each is stated before you choose — rather than
  // three commands whose difference only shows up in the file afterwards.
  const doExport = async (mode: ExportMode): Promise<void> => {
    const configs = store.all();
    if (!configs.length) {
      vscode.window.showInformationMessage("Open DB Client: there are no connections to export.");
      return;
    }
    const includeSecrets = mode !== "redacted";
    const entries = [];
    for (const config of configs) {
      entries.push({
        config,
        secrets: includeSecrets
          ? {
              password: await store.getPassword(config.id),
              sshPassword: await store.getSshPassword(config.id),
              sshPassphrase: await store.getSshPassphrase(config.id),
            }
          : undefined,
      });
    }

    // The plaintext gate. Count what would actually be written — including
    // passwords embedded in connection strings, which no SecretStorage lookup
    // sees — so the dialog states a fact rather than a generic caution. The safer
    // route is offered as a button, not buried in the message.
    if (mode === "plaintext") {
      const { passwords, sshSecrets } = countSecrets(entries);
      const embedded = countEmbeddedCredentials(configs);
      const total = passwords + sshSecrets + embedded;
      if (total === 0) {
        vscode.window.showInformationMessage(
          "Open DB Client: none of your connections have a stored password, so a plaintext export would be identical to the normal one. Exporting without passwords instead.",
        );
        return doExport("redacted");
      }
      const bits = [
        passwords ? `${passwords} database password(s)` : "",
        sshSecrets ? `${sshSecrets} SSH secret(s)` : "",
        embedded ? `${embedded} password(s) embedded in connection strings` : "",
      ].filter(Boolean);
      const choice = await vscode.window.showWarningMessage(
        "Export passwords in PLAIN TEXT?",
        {
          modal: true,
          detail:
            `The file will contain ${bits.join(", ")} — readable by anyone who opens it.\n\n` +
            "Anything that touches that folder gets them too: cloud sync, Time Machine, a search index, or a stray `git add`. " +
            "Delete the file as soon as you are done with it.\n\n" +
            "The encrypted export carries exactly the same passwords, but useless without your passphrase.",
        },
        "Export in plain text",
        "Use the encrypted export instead",
      );
      if (choice === "Use the encrypted export instead") {
        return doExport("encrypted");
      }
      if (choice !== "Export in plain text") {
        return;
      }
    }

    let passphrase: string | undefined;
    if (mode === "encrypted") {
      passphrase = await promptNewPassphrase();
      if (!passphrase) {
        return;
      }
    }
    // The filename carries the warning too — a plaintext export should be
    // recognisable in a folder listing months later, without opening it.
    const suffix =
      mode === "encrypted" ? "encrypted.json" : mode === "plaintext" ? "PLAINTEXT.json" : "json";
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`open-db-client-connections.${suffix}`),
      filters: { JSON: ["json"] },
      saveLabel: "Export",
    });
    if (!target) {
      return;
    }
    try {
      const { file, redactedNames } = buildExport(entries, {
        includeSecrets,
        exportedBy: `open-db-client ${version}`,
        exportedAt: new Date().toISOString(),
        warning:
          mode === "plaintext"
            ? "This file contains UNENCRYPTED credentials. Anyone who reads it can connect to these databases. Delete it when you are done."
            : undefined,
      });
      const body =
        mode === "encrypted"
          ? JSON.stringify(encryptBundle(JSON.stringify(file), passphrase as string), null, 2)
          : JSON.stringify(file, null, 2);
      // 0600 on any credential-bearing file. Best-effort: the mode only applies on
      // creation, and the save dialog may be overwriting something that exists.
      fs.writeFileSync(target.fsPath, body, includeSecrets ? { mode: 0o600 } : {});
      if (includeSecrets) {
        try {
          fs.chmodSync(target.fsPath, 0o600);
        } catch {
          /* non-POSIX filesystem — nothing else changes about the export */
        }
      }
      const n = configs.length;
      if (mode === "encrypted") {
        vscode.window.showInformationMessage(
          `Exported ${n} connection(s) with passwords, encrypted. Without the passphrase this file cannot be opened — there is no recovery.`,
        );
      } else if (mode === "plaintext") {
        vscode.window.showWarningMessage(
          `Exported ${n} connection(s) with passwords in plain text to ${path.basename(target.fsPath)}. Treat that file as a password — delete it once you have imported it.`,
        );
      } else {
        vscode.window.showInformationMessage(
          `Exported ${n} connection(s) without passwords.` +
            (redactedNames.length
              ? ` A password was stripped from the connection string of: ${redactedNames.join(", ")} (usernames kept).`
              : ""),
        );
      }
    } catch (err) {
      logError("exportConnections", err);
      vscode.window.showErrorMessage(`Open DB Client: export failed. ${(err as Error).message}`);
    }
  };

  reg("openDbClient.exportConnections", async () => {
    const picked = await vscode.window.showQuickPick(EXPORT_MODES, {
      title: "Export connections",
      placeHolder: "How much should the file contain?",
    });
    if (picked) {
      await doExport(picked.mode);
    }
  });

  // Import only ever appends: nothing existing is modified, reordered, or removed,
  // and a connection you already have is skipped rather than duplicated.
  reg("openDbClient.importConnections", async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { JSON: ["json"] },
      openLabel: "Import",
    });
    if (!picked?.length) {
      return;
    }
    try {
      let text = fs.readFileSync(picked[0].fsPath, "utf8");
      if (isEncryptedBundle(text)) {
        const passphrase = await vscode.window.showInputBox({
          password: true,
          title: "Import connections",
          prompt: "Passphrase for this encrypted connections file",
          ignoreFocusOut: true,
        });
        if (!passphrase) {
          return;
        }
        text = decryptBundle(text, passphrase);
      }
      const parsed = parseImport(text);
      for (const w of parsed.warnings) {
        logInfo("importConnections", w);
      }
      if (!parsed.connections.length) {
        vscode.window.showWarningMessage(
          `Open DB Client: no importable connections in that file.${warnTail(parsed.warnings)}`,
        );
        return;
      }
      const { added, skipped, secrets } = mergeConnections(store.all(), parsed.connections, newId);
      if (!added.length) {
        vscode.window.showInformationMessage(
          `Open DB Client: nothing to import — all ${skipped.length} connection(s) in that file are already saved.`,
        );
        return;
      }
      const ok = await vscode.window.showInformationMessage(
        `Import ${added.length} connection(s)?` +
          (skipped.length ? ` ${skipped.length} already saved and will be skipped.` : "") +
          " Your existing connections are not changed.",
        { modal: true },
        "Import",
      );
      if (ok !== "Import") {
        return;
      }
      for (const config of added) {
        await store.save(config, secrets.get(config.id) ?? {});
      }
      tree.refresh();
      const parts = [`Imported ${added.length} connection(s)`];
      if (skipped.length) {
        parts.push(`${skipped.length} skipped (already saved)`);
      }
      if (!parsed.hasSecrets) {
        parts.push("no passwords in the file — add them via Edit Connection");
      }
      vscode.window.showInformationMessage(
        `Open DB Client: ${parts.join(" · ")}.${warnTail(parsed.warnings)}`,
      );
    } catch (err) {
      logError("importConnections", err);
      vscode.window.showErrorMessage(`Open DB Client: import failed. ${(err as Error).message}`);
    }
  });

  reg("openDbClient.newQuery", (node: DbNode) => {
    QueryPanel.create(ctx, manager, store, node.connectionId, {
      database: node.nodePath[0],
    });
  });

  const preview = (node: DbNode) =>
    QueryPanel.create(ctx, manager, store, node.connectionId, {
      previewPath: node.nodePath,
    });

  reg("openDbClient.previewTable", preview);
  // Same action, honest title for Redis keys ("Select Top 200" means nothing there).
  reg("openDbClient.viewKey", preview);

  // A live search box wired to a tree node's filter term. The tree re-filters as
  // you type (debounced), so the box behaves like a search field, not a prompt.
  const liveFilterInput = (
    node: DbNode,
    opts: { title: string; placeholder: string; prompt?: string; debounceMs: number },
  ) => {
    const input = vscode.window.createInputBox();
    input.title = opts.title;
    input.placeholder = opts.placeholder;
    if (opts.prompt) input.prompt = opts.prompt;
    input.value = tree.getKeyFilter(node);
    let timer: ReturnType<typeof setTimeout> | undefined;
    input.onDidChangeValue((value) => {
      clearTimeout(timer);
      timer = setTimeout(() => tree.setKeyFilter(node, value), opts.debounceMs);
    });
    input.onDidAccept(() => {
      clearTimeout(timer);
      tree.setKeyFilter(node, input.value);
      input.hide();
    });
    input.onDidHide(() => {
      clearTimeout(timer);
      input.dispose();
    });
    input.show();
  };

  // Redis key search: matches server-side (SCAN MATCH), so debounce a little more.
  reg("openDbClient.searchKeys", (node: DbNode) =>
    liveFilterInput(node, {
      title: `Search keys in ${node.label}`,
      placeholder: "Type to filter — glob supported, e.g. bull:erp-queue:*",
      prompt: "Matches server-side (SCAN MATCH). Plain text matches anywhere in the key.",
      debounceMs: 300,
    }),
  );

  // SQL table search: matches table/view names in the tree, client-side and instant.
  reg("openDbClient.searchTables", (node: DbNode) =>
    liveFilterInput(node, {
      title: `Search tables in ${node.label}`,
      placeholder: "Type to filter tables by name",
      debounceMs: 150,
    }),
  );

  // The pinned "Filter: …" row: clicking it drops the filter. Its path is
  // [db, "@keyfilter"], so the filter is keyed on the parent db path.
  reg("openDbClient.clearKeyFilter", (node: DbNode) => {
    tree.clearKeyFilter(node.connectionId, node.nodePath.slice(0, -1));
  });

  reg("openDbClient.deleteKey", async (node: DbNode) => {
    const key = node.nodePath[node.nodePath.length - 1];
    const ok = await vscode.window.showWarningMessage(
      `Delete key "${key}" from db${node.nodePath[0]}? This cannot be undone.`,
      { modal: true },
      "Delete",
    );
    if (ok !== "Delete") {
      return;
    }
    try {
      const driver = await manager.getDriver(node.connectionId);
      await driver.deleteRow(node.nodePath, {});
      vscode.window.showInformationMessage(`Deleted key "${key}".`);
    } catch (err) {
      vscode.window.showErrorMessage(`Delete key failed: ${(err as Error).message}`);
    } finally {
      tree.refresh();
    }
  });

  reg("openDbClient.setTtl", async (node: DbNode) => {
    const key = node.nodePath[node.nodePath.length - 1];
    try {
      const driver = await manager.getDriver(node.connectionId);
      if (!driver.setTtl) {
        vscode.window.showWarningMessage("This connection does not support TTL.");
        return;
      }
      const answer = await vscode.window.showInputBox({
        title: `Set TTL for "${key}"`,
        prompt: "Seconds until the key expires. Leave blank or 0 to keep it forever.",
        validateInput: (v) => {
          const t = v.trim();
          if (t === "") {
            return undefined;
          }
          const n = Number(t);
          return Number.isFinite(n) && n >= 0 && Number.isInteger(n)
            ? undefined
            : "Enter a whole number of seconds (0 = no expiry)";
        },
      });
      if (answer === undefined) {
        return;
      }
      const seconds = Number(answer.trim() || "0");
      await driver.setTtl(node.nodePath, seconds > 0 ? seconds * 1000 : null);
      vscode.window.showInformationMessage(
        seconds > 0 ? `"${key}" expires in ${seconds}s.` : `"${key}" will no longer expire.`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Set TTL failed: ${(err as Error).message}`);
    } finally {
      tree.refresh();
    }
  });

  reg("openDbClient.newQueryFile", async (node: DbNode) => {
    const { scope, relative } = splitQueryPath(node.nodePath);
    const name = await vscode.window.showInputBox({
      prompt: "Query file name",
      value: "query",
      validateInput: (v) => (v.trim() ? undefined : "Name is required"),
    });
    if (!name) {
      return;
    }
    const uri = await queries.createFile(node.connectionId, scope, relative, name.trim());
    tree.refresh();
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, "sql");
    await vscode.window.showTextDocument(doc);
  });

  reg("openDbClient.newQueryFolder", async (node: DbNode) => {
    const { scope, relative } = splitQueryPath(node.nodePath);
    const name = await vscode.window.showInputBox({
      prompt: "Folder name",
      validateInput: (v) => (v.trim() ? undefined : "Name is required"),
    });
    if (!name) {
      return;
    }
    await queries.createFolder(node.connectionId, scope, relative, name.trim());
    tree.refresh();
  });

  const fileParts = (node: DbNode) => {
    const { scope, relative } = splitQueryPath(node.nodePath);
    return { scope, parent: relative.slice(0, -1), name: relative[relative.length - 1] };
  };

  // Open a query file in VS Code's NATIVE editor. We bind the doc to its
  // connection so our CompletionItemProvider (native IntelliSense) and CodeLens
  // (▶ Run / { } JSON) light up and run against the right server in OUR grid.
  reg("openDbClient.openQueryFile", async (node: DbNode) => {
    const { scope, parent, name } = fileParts(node);
    const uri = queries.fileUri(node.connectionId, scope, parent, name);
    bindQueryDoc(uri, node.connectionId, scope[0] ?? "");
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, "sql");
    await vscode.window.showTextDocument(doc);
  });

  reg("openDbClient.runQueryFile", async (node: DbNode) => {
    const { scope, parent, name } = fileParts(node);
    const sql = await queries.read(queries.fileUri(node.connectionId, scope, parent, name));
    QueryPanel.runInResults(ctx, manager, store, node.connectionId, scope[0], sql);
  });

  // Invoked by the inline CodeLens on query files.
  reg("openDbClient.runSql", (connId: string, database: string, sql: string) => {
    QueryPanel.runInResults(ctx, manager, store, connId, database || undefined, sql);
  });

  reg("openDbClient.runSqlJson", async (connId: string, database: string, sql: string) => {
    try {
      const driver = await manager.getDriver(connId);
      const result = await driver.query(sql, database || undefined);
      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(result.rows, null, 2),
        language: "json",
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  reg("openDbClient.deleteQueryFile", async (node: DbNode) => {
    const { scope, parent, name } = fileParts(node);
    const ok = await vscode.window.showWarningMessage(
      `Delete query file "${name}"?`,
      { modal: true },
      "Delete",
    );
    if (ok === "Delete") {
      await queries.delete(queries.fileUri(node.connectionId, scope, parent, name));
      tree.refresh();
    }
  });

  reg("openDbClient.deleteQueryFolder", async (node: DbNode) => {
    const { scope, relative } = splitQueryPath(node.nodePath);
    const ok = await vscode.window.showWarningMessage(
      `Delete folder "${relative[relative.length - 1]}" and everything in it?`,
      { modal: true },
      "Delete",
    );
    if (ok === "Delete") {
      await queries.delete(queries.dirUri(node.connectionId, scope, relative));
      tree.refresh();
    }
  });

  reg("openDbClient.showDDL", async (node: DbNode) => {
    try {
      const driver = await manager.getDriver(node.connectionId);
      const ddl = await driver.getDDL(node.nodePath);
      const doc = await vscode.workspace.openTextDocument({
        content: ddl,
        language: "sql",
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      vscode.window.showErrorMessage((err as Error).message);
    }
  });

  ctx.subscriptions.push({ dispose: () => void manager.disposeAll() });
}

export function deactivate(): void {
  // Drivers are disposed via the subscription registered in activate().
}

/**
 * Ask for a passphrase twice. There is no recovery for an encrypted export, so
 * a typo has to be caught here rather than at import time on the other machine.
 */
async function promptNewPassphrase(): Promise<string | undefined> {
  const first = await vscode.window.showInputBox({
    password: true,
    title: "Export connections (encrypted)",
    prompt: "Passphrase to encrypt the file. There is no way to recover it.",
    ignoreFocusOut: true,
    validateInput: (v) => (v.length < 8 ? "Use at least 8 characters." : undefined),
  });
  if (!first) {
    return undefined;
  }
  const second = await vscode.window.showInputBox({
    password: true,
    title: "Export connections (encrypted)",
    prompt: "Type the same passphrase again",
    ignoreFocusOut: true,
    validateInput: (v) => (v === first ? undefined : "The two passphrases do not match."),
  });
  return second === first ? first : undefined;
}

/** Never swallow a dropped entry — say how many and where to read why. */
function warnTail(warnings: string[]): string {
  if (!warnings.length) {
    return "";
  }
  return ` ${warnings.length} entry/entries in the file were skipped — see View → Output → "Open DB Client".`;
}
