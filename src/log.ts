import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

/** Create the extension's output channel (call once at activation). */
export function initLog(ctx: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel("Open DB Client");
  ctx.subscriptions.push(channel);
}

function stamp(): string {
  return new Date().toISOString();
}

export function logInfo(scope: string, message: string): void {
  channel?.appendLine(`${stamp()} [${scope}] ${message}`);
}

/** Log an error with its stack trace for later diagnosis (never shown to user). */
export function logError(scope: string, err: unknown): void {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  channel?.appendLine(`${stamp()} [${scope}] ERROR: ${detail}`);
}
