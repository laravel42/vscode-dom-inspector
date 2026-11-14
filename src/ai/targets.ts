import * as vscode from "vscode";

/**
 * AI targets: where "Send to AI" delivers an element snapshot.
 *
 * DOM Inspector never talks to a model itself. It writes a Markdown snapshot
 * (ai-context.ts) and hands it to whichever assistant the user works with,
 * through that assistant's own "add file / selection to chat" command:
 *
 *   claude-code  Claude Code          claude-vscode.insertAtMention (active editor → @file)
 *   cursor       Cursor chat          composer.addfilestocomposer(uri, {useExactResource})
 *   kiro         Kiro agent           kiroAgent.selectFilesAsContext(uri, [uri])
 *   copilot      VS Code chat         workbench.action.chat.open({query, attachFiles})
 *   cline        Cline                cline.addToChat(range) on the active editor
 *   roo-code     Roo Code             roo-cline.addToContext(path, text, start, end)
 *   continue     Continue             continue.selectFilesAsContext(uri, [uri])
 *   custom       any other tool       a user-configured command + args
 *   clipboard    anything             copies the Markdown
 *
 * Every command above was checked against the tool's shipped code
 * (extension bundles / published sources), not guessed. Anything else —
 * Windsurf, Gemini, Codex, Amazon Q, Augment… — is reachable via "custom",
 * the clipboard, the snapshot file, or the MCP server.
 */

export type AiTargetId =
  | "claude-code" | "cursor" | "kiro" | "copilot" | "cline" | "roo-code" | "continue"
  | "custom" | "clipboard";

export const AI_TARGET_IDS: AiTargetId[] = [
  "claude-code", "cursor", "kiro", "copilot", "cline", "roo-code", "continue", "custom", "clipboard",
];

/** Order used by "auto" when nothing was chosen yet: dedicated agents first, then built-in chats. */
export const AUTO_PRIORITY: AiTargetId[] = [
  "custom", "claude-code", "cline", "roo-code", "continue", "kiro", "cursor", "copilot", "clipboard",
];

export const TARGET_LABELS: Record<AiTargetId, string> = {
  "claude-code": "Claude Code",
  "cursor": "Cursor Chat",
  "kiro": "Kiro",
  "copilot": "Copilot Chat",
  "cline": "Cline",
  "roo-code": "Roo Code",
  "continue": "Continue",
  "custom": "Custom command",
  "clipboard": "Clipboard",
};

/** What the editor offers; abstracted so target selection is unit-testable. */
export interface AiEnvironment {
  appName: string;
  hasExtension(id: string): boolean;
  customCommand: string;
}

export function isTargetAvailable(id: AiTargetId, env: AiEnvironment): boolean {
  switch (id) {
    case "claude-code": return env.hasExtension("anthropic.claude-code");
    case "cline": return env.hasExtension("saoudrizwan.claude-dev");
    case "roo-code": return env.hasExtension("RooVeterinaryInc.roo-cline");
    case "continue": return env.hasExtension("Continue.continue");
    case "kiro": return env.hasExtension("kiro.kiro-agent") || /\bkiro\b/i.test(env.appName);
    case "cursor": return /\bcursor\b/i.test(env.appName);
    case "copilot": return env.hasExtension("GitHub.copilot-chat");
    case "custom": return env.customCommand.trim().length > 0;
    case "clipboard": return true;
  }
}

export function availableTargets(env: AiEnvironment): AiTargetId[] {
  return AUTO_PRIORITY.filter((id) => isTargetAvailable(id, env));
}

/**
 * The target "Send to AI" uses: an explicit setting wins; with "auto", the
 * last target the user picked (if still available), else the first available
 * in AUTO_PRIORITY. Clipboard is always available, so this never fails.
 */
export function resolvePrimaryTarget(setting: string, available: AiTargetId[], lastUsed?: string): AiTargetId {
  if (setting && setting !== "auto" && (AI_TARGET_IDS as string[]).includes(setting)) {
    return setting as AiTargetId;
  }
  if (lastUsed && (available as string[]).includes(lastUsed)) return lastUsed as AiTargetId;
  return available[0] ?? "clipboard";
}

export interface AiPayload {
  snapshotFile: string;   // absolute path to the Markdown snapshot
  markdown: string;       // its content
  prompt: string;         // one-line instruction, for targets that take text
}

/** Replace ${file} ${path} ${relativePath} ${markdown} ${prompt} in custom-command args (recursively). */
export function substituteArgs(
  args: unknown,
  values: { file: unknown; path: string; relativePath: string; markdown: string; prompt: string },
): unknown {
  if (typeof args === "string") {
    if (args === "${file}") return values.file; // keep it a Uri, not a string
    return args.replace(/\$\{(path|relativePath|markdown|prompt)\}/g, (_m, k: string) => (values as Record<string, string>)[k]);
  }
  if (Array.isArray(args)) return args.map((a) => substituteArgs(a, values));
  if (args && typeof args === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) out[k] = substituteArgs(v, values);
    return out;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export function currentEnvironment(): AiEnvironment {
  const cfg = vscode.workspace.getConfiguration("domInspector.ai");
  return {
    appName: vscode.env.appName || "",
    hasExtension: (id) => !!vscode.extensions.getExtension(id),
    customCommand: cfg.get<string>("customCommand", ""),
  };
}

async function activateExtension(id: string): Promise<void> {
  const ext = vscode.extensions.getExtension(id);
  if (ext && !ext.isActive) await ext.activate();
}

async function closeTabsFor(uri: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
}

/**
 * Some assistants only read the *active editor* ("add selection to chat").
 * Briefly open the snapshot (never replacing a preview tab), select nothing or
 * everything, run `fn`, then close it again.
 */
async function withSnapshotEditor(
  file: string,
  select: "none" | "all",
  fn: (editor: vscode.TextEditor, fullRange: vscode.Range) => PromiseLike<unknown>,
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two, preview: false, preserveFocus: false });
  const last = doc.lineAt(Math.max(0, doc.lineCount - 1));
  const full = new vscode.Range(0, 0, last.lineNumber, last.text.length);
  editor.selection = select === "all" ? new vscode.Selection(full.start, full.end) : new vscode.Selection(0, 0, 0, 0);
  try {
    await fn(editor, full);
  } finally {
    await closeTabsFor(doc.uri);
  }
}

/** Deliver the payload to one target. Throws when the target can't take it. */
export async function sendToTarget(id: AiTargetId, p: AiPayload): Promise<void> {
  const uri = vscode.Uri.file(p.snapshotFile);
  const exec = (cmd: string, ...args: unknown[]) => vscode.commands.executeCommand(cmd, ...args);

  switch (id) {
    case "claude-code":
      await activateExtension("anthropic.claude-code");
      // Empty selection → mentions the whole file: "@.dom-inspector/element-….md"
      await withSnapshotEditor(p.snapshotFile, "none", () => exec("claude-vscode.insertAtMention"));
      return;

    case "cursor":
      await exec("composer.addfilestocomposer", uri, { useExactResource: true });
      return;

    case "kiro":
      await exec("kiroAgent.selectFilesAsContext", uri, [uri]);
      return;

    case "copilot":
      await exec("workbench.action.chat.open", { query: p.prompt, isPartialQuery: true, attachFiles: [uri] });
      return;

    case "cline":
      await activateExtension("saoudrizwan.claude-dev");
      await withSnapshotEditor(p.snapshotFile, "all", (_e, full) => exec("cline.addToChat", full));
      return;

    case "roo-code": {
      await activateExtension("RooVeterinaryInc.roo-cline");
      const lines = p.markdown.split("\n").length;
      await exec("roo-cline.addToContext", vscode.workspace.asRelativePath(uri), p.markdown, 1, lines);
      return;
    }

    case "continue":
      await activateExtension("Continue.continue");
      await exec("continue.selectFilesAsContext", uri, [uri]);
      return;

    case "custom": {
      const cfg = vscode.workspace.getConfiguration("domInspector.ai");
      const command = cfg.get<string>("customCommand", "").trim();
      if (!command) throw new Error("domInspector.ai.customCommand is not set");
      const args = substituteArgs(cfg.get<unknown[]>("customArgs", ["${file}"]), {
        file: uri,
        path: p.snapshotFile,
        relativePath: vscode.workspace.asRelativePath(uri),
        markdown: p.markdown,
        prompt: p.prompt,
      }) as unknown[];
      const run = () => exec(command, ...(Array.isArray(args) ? args : [args]));
      if (cfg.get<boolean>("customSelectSnapshot", false)) await withSnapshotEditor(p.snapshotFile, "all", run);
      else await run();
      return;
    }

    case "clipboard":
      await vscode.env.clipboard.writeText(p.markdown);
      return;
  }
}
