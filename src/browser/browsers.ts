import * as vscode from "vscode";
import { BridgeMessage } from "../types";
import { onPageClientsChanged, onPageMessage, pageClients, sendToPageClients } from "./page-channel";

/**
 * Which browser shows the inspected page. All of them load the page through
 * DOM Inspector's proxy (which injects the inspector); they differ in how the
 * inspector talks back:
 *
 *   panel       DOM Inspector's own webview panel (iframe + postMessage relay)
 *   integrated  VS Code's integrated browser      workbench.action.browser.open
 *   cursor      Cursor's browser tab              workbench.action.openBrowserEditor
 *   simple      Simple Browser                    simpleBrowser.api.open
 *   external    the system browser                vscode.env.openExternal
 *
 * Everything except "panel" uses the HTTP page channel in proxy.ts.
 */

export type BrowserKind = "panel" | "integrated" | "cursor" | "simple" | "external";

export const BROWSER_LABELS: Record<BrowserKind, string> = {
  panel: "DOM Inspector panel",
  integrated: "VS Code integrated browser",
  cursor: "Cursor browser",
  simple: "Simple Browser",
  external: "System browser",
};

const OPEN_COMMANDS: Partial<Record<BrowserKind, string>> = {
  integrated: "workbench.action.browser.open",
  cursor: "workbench.action.openBrowserEditor",
  simple: "simpleBrowser.api.open",
};

/**
 * "auto" prefers the editor's own full browser (a real Chromium view, with its
 * own devtools and navigation), then DOM Inspector's panel. Simple Browser and
 * the system browser are only used when chosen explicitly.
 */
export function resolveBrowser(setting: string, hasCommand: (id: string) => boolean): BrowserKind {
  const explicit: BrowserKind[] = ["panel", "integrated", "cursor", "simple", "external"];
  if ((explicit as string[]).includes(setting)) {
    const kind = setting as BrowserKind;
    const cmd = OPEN_COMMANDS[kind];
    return !cmd || hasCommand(cmd) ? kind : "panel";
  }
  if (hasCommand(OPEN_COMMANDS.integrated!)) return "integrated";
  if (hasCommand(OPEN_COMMANDS.cursor!)) return "cursor";
  return "panel";
}

/** Open `url` in a browser we don't own. */
export async function openInBrowser(kind: Exclude<BrowserKind, "panel">, url: string): Promise<void> {
  switch (kind) {
    case "integrated":
      await vscode.commands.executeCommand("workbench.action.browser.open", { url, openToSide: false });
      return;
    case "cursor":
      await vscode.commands.executeCommand("workbench.action.openBrowserEditor", { url, reuseExistingUrlTab: true });
      return;
    case "simple":
      await vscode.commands.executeCommand("simpleBrowser.api.open", vscode.Uri.parse(url), { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
      return;
    case "external":
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return;
  }
}

/** Common surface of the two page transports (webview relay and HTTP). */
export interface PageChannel {
  sendToPage(msg: BridgeMessage): void;
  onMessage(callback: (msg: BridgeMessage) => void): void;
  onConnectionLost(callback: () => void): void;
  onConnectionRestored(callback: () => void): void;
  readonly isConnected: boolean;
  dispose(): void;
}

/**
 * Page channel for browsers we don't own: messages arrive as POSTs on the
 * proxy, and go out over the page's Server-Sent Events stream. Replies go to
 * the tab that spoke last, so two open tabs don't both answer.
 */
export class HttpPageChannel implements PageChannel {
  private readonly messageCallbacks: Array<(msg: BridgeMessage) => void> = [];
  private readonly lostCallbacks: Array<() => void> = [];
  private readonly restoredCallbacks: Array<() => void> = [];
  private readonly unsubscribe: Array<() => void> = [];
  private activeClient: string | undefined;
  private connected = false;
  private disposed = false;

  constructor() {
    this.connected = pageClients().length > 0;
    this.unsubscribe.push(onPageMessage((raw, clientId) => {
      if (this.disposed) return;
      this.activeClient = clientId;
      for (const cb of this.messageCallbacks) cb(raw as unknown as BridgeMessage);
    }));
    this.unsubscribe.push(onPageClientsChanged((clients) => {
      if (this.disposed) return;
      if (this.activeClient && !clients.includes(this.activeClient)) this.activeClient = clients[clients.length - 1];
      const now = clients.length > 0;
      if (now === this.connected) return;
      this.connected = now;
      for (const cb of now ? this.restoredCallbacks : this.lostCallbacks) cb();
    }));
  }

  sendToPage(msg: BridgeMessage): void {
    if (this.disposed) return;
    const target = this.activeClient && pageClients().includes(this.activeClient) ? this.activeClient : undefined;
    sendToPageClients(msg, target);
  }

  onMessage(callback: (msg: BridgeMessage) => void): void { this.messageCallbacks.push(callback); }
  onConnectionLost(callback: () => void): void { this.lostCallbacks.push(callback); }
  onConnectionRestored(callback: () => void): void { this.restoredCallbacks.push(callback); }
  get isConnected(): boolean { return this.connected; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubscribe) u();
  }
}
