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
  /** "Inspect the page open in Cursor's browser" was clicked. */
  onAttachBrowserTab?(): void;
  /** "Detach from current page" was clicked. */
  onDetach?(): void;
}

/**
 * The DevTools-style sidebar webview: Elements, Styles and Computed tabs, a
 * start screen and a bottom bar. Its document, styles and script are
 * src/webview/sidebar.{html,css,js}. Diagnostic logging goes to the logger
 * passed in (the "DOM Inspector" Output channel), not to the webview.
 */
export class InspectorSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "domInspector.inspectorSidebar";

  private view: vscode.WebviewView | undefined;
  private readonly callbacks: SidebarCallbacks;
  /** Shown at the bottom of the sidebar, e.g. "v0.7.4" or "v0.7.4 (dev)". */
  private readonly versionLabel: string;
  private readonly logger: (line: string) => void;
  /**
   * The latest message of each state-carrying type. If VS Code re-creates the
   * view (e.g. after it was closed), the new webview says "sidebar_ready" and
   * gets these replayed, so the session survives.
   */
  private readonly latestState = new Map<string, SidebarMessage>();
  private static readonly REPLAYED_TYPES = [
    "attach_available", "update_dom_tree", "update_full_tree", "update_element", "browser_state", "inspect_state",
  ];

  constructor(callbacks: SidebarCallbacks, versionLabel = "", logger: (line: string) => void = () => {}) {
    this.callbacks = callbacks;
    this.versionLabel = versionLabel;
    this.logger = logger;
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
      } else if (msg.type === "detach") {
        this.callbacks.onDetach?.();
      } else if (msg.type === "open_url_command") {
        vscode.commands.executeCommand("domInspector.openUrl");
      } else if (msg.type === "attach_browser_tab") {
        this.callbacks.onAttachBrowserTab?.();
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

  /** Diagnostic log line (bridge messages, source lookups, MCP posts…), to the logger. */
  log(message: string): void {
    this.logger(message);
  }

  /** Reflect picking mode on the inspect button (the extension is the source of truth). */
  setInspecting(active: boolean): void {
    this.postMessage({ type: "inspect_state", active });
  }

  /** Show the "inspect the page open in Cursor's browser" button (Cursor only). */
  setAttachAvailable(available: boolean): void {
    this.postMessage({ type: "attach_available", available });
  }

  /** Show or hide the empty state based on browser panel status. */
  setBrowserOpen(open: boolean, url = ""): void {
    this.postMessage({ type: "browser_state", open, url });
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                         */
  /* ------------------------------------------------------------------ */

  private postMessage(msg: SidebarMessage): void {
    if (InspectorSidebarProvider.REPLAYED_TYPES.includes(msg.type)) {
      this.latestState.set(msg.type, msg);
    }
    this.view?.webview.postMessage(msg);
  }

  /** Re-send the remembered state to a freshly created webview, in dependency order. */
  private replayState(): void {
    const webview = this.view?.webview;
    if (!webview) return;
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
