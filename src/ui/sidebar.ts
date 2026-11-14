import * as vscode from "vscode";
import { ElementData, ChildSummary, HoverData, FullTreeNode } from "../types";
import { fillTemplate, webviewAsset } from "../webview/assets";

/** A message from the extension to the sidebar webview. */
type SidebarMessage = { type: string; [key: string]: unknown };

/** Callbacks the host wires up so the sidebar can communicate outward. */
export interface SidebarCallbacks {
  onRequestChildren(selector: string): void;
  onOpenUrl?(url: string): void;
  onSetStyle?(selector: string, property: string, value: string): void;
  onToggleStyle?(selector: string, property: string, enabled: boolean): void;
  onStopInspect?(): void;
  /** A node was clicked in the Elements tree. */
  onSelectNode?(selector: string): void;
}

/**
 * The DevTools-style sidebar webview: URL omnibox, and Elements, Styles,
 * Computed and Console tabs. Its document, styles and script are
 * src/webview/sidebar.{html,css,js}.
 */
export class InspectorSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "domInspector.inspectorSidebar";

  private view: vscode.WebviewView | undefined;
  private readonly callbacks: SidebarCallbacks;
  private readonly readyCallbacks: Array<() => void> = [];
  /** Shown at the bottom of the sidebar, e.g. "v0.7.4" or "v0.7.4 (dev)". */
  private readonly versionLabel: string;
  /**
   * The latest message of each state-carrying type, and recent Console lines.
   * If VS Code re-creates the view (e.g. after it was closed), the new webview
   * says "sidebar_ready" and gets these replayed, so the session survives.
   */
  private readonly latestState = new Map<string, SidebarMessage>();
  private readonly logLines: SidebarMessage[] = [];
  private static readonly REPLAYED_TYPES = [
    "url_history", "update_dom_tree", "update_full_tree", "update_element", "browser_state", "inspect_state",
  ];
  private static readonly MAX_REPLAYED_LOG_LINES = 300;

  constructor(callbacks: SidebarCallbacks, versionLabel = "") {
    this.callbacks = callbacks;
    this.versionLabel = versionLabel;
  }

  /* ------------------------------------------------------------------ */
  /*  WebviewViewProvider                                                */
  /* ------------------------------------------------------------------ */

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml();

    webviewView.webview.onDidReceiveMessage((msg: { type: string; selector?: string; url?: string; [k: string]: unknown }) => {
      if (msg.type === "sidebar_ready") {
        this.replayState();
      } else if (msg.type === "select_node" && msg.selector) {
        this.callbacks.onSelectNode?.(msg.selector);
      } else if (msg.type === "request_children" && msg.selector) {
        this.callbacks.onRequestChildren(msg.selector);
      } else if (msg.type === "open_url_direct" && msg.url) {
        if (this.callbacks.onOpenUrl) {
          this.callbacks.onOpenUrl(msg.url);
        }
      } else if (msg.type === "start_inspect") {
        vscode.commands.executeCommand("domInspector.inspectElement");
      } else if (msg.type === "stop_inspect") {
        this.callbacks.onStopInspect?.();
      } else if (msg.type === "set_style") {
        if (this.callbacks.onSetStyle) {
          this.callbacks.onSetStyle(msg.selector as string, msg.property as string, msg.value as string);
        }
      } else if (msg.type === "toggle_style") {
        if (this.callbacks.onToggleStyle) {
          this.callbacks.onToggleStyle(msg.selector as string, msg.property as string, msg.enabled as boolean);
        }
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    // Fire ready callbacks
    for (const cb of this.readyCallbacks) cb();
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                        */
  /* ------------------------------------------------------------------ */

  /** Render full element details in the sidebar. */
  updateElement(data: ElementData, sourceFile?: string): void {
    this.postMessage({ type: "update_element", data, sourceFile: sourceFile || "" });
  }

  /** Render / refresh the DOM tree with the given root children. */
  updateDOMTree(children: ChildSummary[]): void {
    this.postMessage({ type: "update_dom_tree", children });
  }

  /** Deliver loaded children for a specific parent node (lazy expand). */
  childrenLoaded(selector: string, children: ChildSummary[]): void {
    this.postMessage({ type: "children_loaded", selector, children });
  }

  /** Update the full tree from <html> root. */
  updateFullTree(tree: FullTreeNode): void {
    this.postMessage({ type: "update_full_tree", tree });
  }

  /** Expand the tree to reveal and highlight a specific node. */
  expandToNode(selector: string): void {
    this.postMessage({ type: "expand_to_node", selector });
  }

  /** Lightweight hover preview — updates the element summary without full detail. */
  updateHoverPreview(data: HoverData): void {
    this.postMessage({ type: "update_hover_preview", data });
  }

  /** Send a debug log message to the sidebar panel. */
  log(message: string): void {
    this.postMessage({ type: "debug_log", message });
  }

  /** Reflect picking mode on the inspect button (the extension is the source of truth). */
  setInspecting(active: boolean): void {
    this.postMessage({ type: "inspect_state", active });
  }

  /** Show or hide the empty state based on browser panel status. */
  setBrowserOpen(open: boolean): void {
    this.postMessage({ type: "browser_state", open });
  }

  /** Update the URL history in the sidebar autocomplete. */
  updateUrlHistory(history: string[]): void {
    this.postMessage({ type: "url_history", history });
  }

  /** Register a callback for when the sidebar webview is ready. */
  onReady(callback: () => void): void {
    this.readyCallbacks.push(callback);
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                         */
  /* ------------------------------------------------------------------ */

  private postMessage(msg: SidebarMessage): void {
    if (InspectorSidebarProvider.REPLAYED_TYPES.includes(msg.type)) {
      this.latestState.set(msg.type, msg);
    } else if (msg.type === "debug_log") {
      this.logLines.push(msg);
      if (this.logLines.length > InspectorSidebarProvider.MAX_REPLAYED_LOG_LINES) this.logLines.shift();
    }
    this.view?.webview.postMessage(msg);
  }

  /** Re-send the remembered state to a freshly created webview, in dependency order. */
  private replayState(): void {
    const webview = this.view?.webview;
    if (!webview) return;
    for (const line of this.logLines) webview.postMessage(line);
    for (const type of InspectorSidebarProvider.REPLAYED_TYPES) {
      const msg = this.latestState.get(type);
      if (msg) webview.postMessage(msg);
    }
  }

  private buildHtml(): string {
    return fillTemplate(webviewAsset("sidebar.html"), {
      style: webviewAsset("sidebar.css"),
      script: webviewAsset("sidebar.js"),
      version: escapeHtml(this.versionLabel),
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
