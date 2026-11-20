import * as vscode from "vscode";
import * as path from "path";
import { inspectorScript, proxyOrigin, startProxy, stopProxy } from "./browser/proxy";
import { channelToken } from "./browser/page-channel";
import { Injection, currentCursorTab, cursorBrowserAvailable, detachFromCursorTab, injectIntoCursorTab, isInspectableUrl } from "./browser/cursor-browser";
import { BridgeChannel, panelHtml } from "./browser/panel";
import { BROWSER_LABELS, BrowserKind, HttpPageChannel, PageChannel, openInBrowser, resolveBrowser } from "./browser/browsers";
import { InspectorSidebarProvider } from "./ui/sidebar";
import { ComponentBreadcrumb } from "./ui/breadcrumb";
import { BridgeMessage, ElementData, FullTreeNode } from "./types";
import {
  SNAPSHOT_DIR,
  buildElementMarkdown,
  elementLabel,
  snapshotFileName,
  writeSnapshot,
} from "./ai/context";
import {
  AiTargetId,
  TARGET_LABELS,
  availableTargets,
  currentEnvironment,
  resolvePrimaryTarget,
  sendToTarget,
} from "./ai/targets";
import { McpHost, StyleChange, autoConfigureMcp, publishSelection, publishStyleChange, setupMcpForAiTools } from "./ai/mcp";

let browserPanel: vscode.WebviewPanel | undefined;
let bridge: PageChannel | undefined;
/** Which browser is showing the page (see browser/browsers.ts). */
let browserKind: BrowserKind | undefined;

const breadcrumb = new ComponentBreadcrumb();

let connectionLostMsg: vscode.Disposable | undefined;
/** Where the inspector is injected when attached to a page in Cursor's browser. */
let cursorInjection: Injection | undefined;
/** The next element_picked answers a click in the sidebar's Elements tree. */
let treeSelectPending = false;

const MAX_URL_HISTORY = 50;
let urlHistory: string[] = [];
let extensionContext: vscode.ExtensionContext;
let currentPageUrl = "";
let output: vscode.OutputChannel;

/** The element the [DOM] commands act on: the last one picked or sent. */
let lastPick: { element: ElementData } | null = null;
/** Style edits made in the sidebar since the last pick (one entry per selector+property). */
let styleChanges: StyleChange[] = [];

const LAST_TARGET_KEY = "domInspector.ai.lastTarget";

/** "v0.7.4", plus "(dev)" when running from source in an Extension Development Host. */
function versionLabel(context: vscode.ExtensionContext): string {
  const version = String(context.extension?.packageJSON?.version ?? "?");
  return `v${version}${context.extensionMode === vscode.ExtensionMode.Development ? " (dev)" : ""}`;
}

function mcpHost(): McpHost {
  return { extensionPath: extensionContext.extensionPath, globalStoragePath: extensionContext.globalStorageUri.fsPath, output };
}

// ---------------------------------------------------------------------------
// AI targets
// ---------------------------------------------------------------------------

function primaryTarget(): AiTargetId {
  const setting = vscode.workspace.getConfiguration("domInspector.ai").get<string>("target", "auto");
  return resolvePrimaryTarget(setting, availableTargets(currentEnvironment()), extensionContext.workspaceState.get<string>(LAST_TARGET_KEY));
}

function pushAiTargetToPage(): void {
  bridge?.sendToPage({ type: "ai_targets", primary: TARGET_LABELS[primaryTarget()] });
}

/** Quick pick of the assistants available in this editor; remembers the choice. */
async function chooseAiTarget(): Promise<AiTargetId | undefined> {
  const env = currentEnvironment();
  const available = availableTargets(env);
  const primary = primaryTarget();
  type Item = vscode.QuickPickItem & { id?: AiTargetId; configure?: boolean };
  const items: Item[] = available.map((id) => ({
    label: TARGET_LABELS[id],
    description: id === primary ? "current" : id === "clipboard" ? "paste anywhere" : undefined,
    id,
  }));
  items.push({ label: "$(gear) Configure a custom command…", description: "for any other AI extension", configure: true });
  const pick = await vscode.window.showQuickPick(items, { title: "Send DOM elements to…" });
  if (!pick) return undefined;
  if (pick.configure) {
    await vscode.commands.executeCommand("workbench.action.openSettings", "domInspector.ai");
    return undefined;
  }
  await extensionContext.workspaceState.update(LAST_TARGET_KEY, pick.id);
  pushAiTargetToPage();
  return pick.id;
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  urlHistory = context.globalState.get<string[]>("domInspector.urlHistory", []);
  output = vscode.window.createOutputChannel("DOM Inspector");
  output.appendLine(`DOM Inspector activated in ${vscode.env.appName}`);

  autoConfigureMcp(mcpHost());

  // --- Sidebar provider ---
  const sidebarProvider = new InspectorSidebarProvider({
    onRequestChildren(selector: string) {
      if (bridge) {
        bridge.sendToPage({ type: "get_children", selector });
      }
    },
    onOpenUrl(url: string) {
      openUrl(sidebarProvider, url);
    },
    onSetStyle(selector: string, property: string, value: string) {
      if (bridge) bridge.sendToPage({ type: "set_style", selector, property, value });
      recordStyleChange(selector, property, value);
    },
    onToggleStyle(selector: string, property: string, enabled: boolean) {
      if (bridge) bridge.sendToPage({ type: "toggle_style", selector, property, enabled });
    },
    onStopInspect() {
      stopInspection(sidebarProvider);
    },
    onAttachBrowserTab() {
      inspectBrowserTab(sidebarProvider);
    },
    onDetach() {
      detachFromPage(sidebarProvider);
    },
    onSelectNode(selector: string) {
      // Inspect the clicked node in the page; it answers with element_picked.
      if (!bridge) return;
      treeSelectPending = true;
      bridge.sendToPage({ type: "inspect_node", selector });
    },
  }, versionLabel(context), (line) => {
    // Diagnostic log (was the sidebar's Console tab): Output → DOM Inspector.
    output.appendLine(`[${new Date().toLocaleTimeString("en", { hour12: false })}] ${line}`);
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      InspectorSidebarProvider.viewType,
      sidebarProvider,
      // Keep the sidebar alive while another view is shown, so switching views
      // in the activity bar doesn't reset the tree, selection and console.
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // Send initial URL history to sidebar when it becomes visible

  // Offer "inspect the page open in Cursor's browser" where that browser exists.
  cursorBrowserAvailable().then((available) => sidebarProvider.setAttachAvailable(available), () => {});

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand("domInspector.openUrl", () => openUrl(sidebarProvider)),
    vscode.commands.registerCommand("domInspector.inspectElement", () => activateInspection(sidebarProvider)),
    vscode.commands.registerCommand("domInspector.selectNode", () => runElementTask("select", sidebarProvider)),
    vscode.commands.registerCommand("domInspector.analyzeNode", () => runElementTask("analyze", sidebarProvider)),
    vscode.commands.registerCommand("domInspector.applyStyles", () => runElementTask("apply-styles", sidebarProvider)),
    vscode.commands.registerCommand("domInspector.removeNode", () => runElementTask("remove", sidebarProvider)),
    vscode.commands.registerCommand("domInspector.chooseAiTarget", () => chooseAiTarget()),
    vscode.commands.registerCommand("domInspector.setupMcp", () => setupMcpForAiTools(mcpHost())),
    vscode.commands.registerCommand("domInspector.chooseBrowser", () => chooseBrowser(sidebarProvider)),
    vscode.commands.registerCommand("domInspector.inspectBrowserTab", () => inspectBrowserTab(sidebarProvider)),
    vscode.commands.registerCommand("domInspector.detach", () => detachFromPage(sidebarProvider)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("domInspector.ai")) pushAiTargetToPage();
      if (e.affectsConfiguration("domInspector.mcp")) autoConfigureMcp(mcpHost());
    }),
    vscode.extensions.onDidChange(() => pushAiTargetToPage()),
  );

  context.subscriptions.push({ dispose: () => breadcrumb.dispose() });
}

// ---------------------------------------------------------------------------
// Open URL — create browser panel with proxy
// ---------------------------------------------------------------------------

/** Ask for a URL: type one, or pick from the recent ones (most recent first). */
function promptForUrl(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.title = "DOM Inspector: Open URL";
    qp.placeholder = "Type a URL (e.g. http://localhost:5173) or pick a recent one";
    qp.value = currentPageUrl || (urlHistory.length ? "" : "http://localhost:5173");
    const items = () => {
      const typed = qp.value.trim();
      const recent = urlHistory.map((u) => ({ label: u, description: u === currentPageUrl ? "current" : "recent" }));
      return typed && !urlHistory.includes(typed) ? [{ label: typed, description: "open" }, ...recent] : recent;
    };
    qp.items = items();
    qp.onDidChangeValue(() => { qp.items = items(); });
    let done = false;
    qp.onDidAccept(() => {
      done = true;
      resolve(qp.selectedItems[0]?.label ?? (qp.value.trim() || undefined));
      qp.hide();
    });
    qp.onDidHide(() => { if (!done) resolve(undefined); qp.dispose(); });
    qp.show();
  });
}

async function openUrl(sidebarProvider: InspectorSidebarProvider, directUrl?: string, forceKind?: BrowserKind) {
  const url = directUrl ?? await promptForUrl();
  if (!url) return;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    vscode.window.showWarningMessage(`Not a valid URL: ${url}`);
    return;
  }

  rememberUrl(url);

  sidebarProvider.log(`opening ${url}`);
  currentPageUrl = url;
  const proxyPort = await startProxy(url);
  // Keep the path, query and hash: the proxy maps them onto the target origin.
  const proxyUrl = `http://127.0.0.1:${proxyPort}${target.pathname}${target.search}${target.hash}`;

  let kind = forceKind;
  if (!kind) {
    const commands = new Set(await vscode.commands.getCommands(true));
    kind = resolveBrowser(vscode.workspace.getConfiguration("domInspector").get<string>("browser", "auto"), (id) => commands.has(id));
  }
  sidebarProvider.log(`proxy on :${proxyPort} → ${BROWSER_LABELS[kind]}`);

  if (kind !== "panel") {
    try {
      useHttpChannel(sidebarProvider, kind);
      await openInBrowser(kind, proxyUrl);
      sidebarProvider.setBrowserOpen(true, currentPageUrl);
      if (kind === "external") {
        vscode.window.showInformationMessage(`Opened ${url} in your browser through DOM Inspector. Right-click elements there to inspect or send them to AI.`);
      }
      return;
    } catch (err) {
      sidebarProvider.log(`${BROWSER_LABELS[kind]} failed: ${err}`);
      vscode.window.showWarningMessage(`Couldn't open the ${BROWSER_LABELS[kind]} (${err instanceof Error ? err.message : err}). Using the DOM Inspector panel instead.`);
    }
  }
  openPanel(sidebarProvider, proxyUrl, url);
}

function rememberUrl(url: string): void {
  urlHistory = urlHistory.filter(u => u !== url);
  urlHistory.unshift(url);
  if (urlHistory.length > MAX_URL_HISTORY) urlHistory.length = MAX_URL_HISTORY;
  extensionContext.globalState.update("domInspector.urlHistory", urlHistory);
}

// ---------------------------------------------------------------------------
// Attach to the page open in Cursor's browser (no URL, no proxy in front)
// ---------------------------------------------------------------------------

type AttachResult = "attached" | "unavailable" | "no-tab" | "failed";

/**
 * Inject the inspector into the page currently open in Cursor's browser tab.
 * The page is not proxied: the proxy only hosts the page channel, which the
 * page reaches cross-origin (CORS, token-protected).
 */
async function attachToCursorBrowser(sidebarProvider: InspectorSidebarProvider, quietIfNoTab = false): Promise<AttachResult> {
  if (!(await cursorBrowserAvailable())) {
    if (!quietIfNoTab) vscode.window.showWarningMessage("Inspecting the open browser tab needs Cursor's built-in browser. Use DOM Inspector: Open URL instead.");
    return "unavailable";
  }
  let tab;
  try {
    tab = await currentCursorTab();
  } catch (err) {
    sidebarProvider.log(`cursor browser: listing tabs failed — ${err}`);
    if (!quietIfNoTab) vscode.window.showWarningMessage(`Couldn't read Cursor's browser tabs (${err instanceof Error ? err.message : err}).`);
    return "failed";
  }
  if (!tab) {
    if (!quietIfNoTab) vscode.window.showWarningMessage("No page is open in Cursor's browser. Open your app there first, or use DOM Inspector: Open URL.");
    return "no-tab";
  }
  if (!isInspectableUrl(tab.url)) {
    vscode.window.showWarningMessage(`Can't inspect ${tab.url}: only http(s) pages can be inspected.`);
    return "failed";
  }

  sidebarProvider.log(`attaching to the Cursor browser tab: ${tab.url}`);
  useHttpChannel(sidebarProvider, "cursor");
  await startProxy(tab.url);   // hosts the page channel
  if (cursorInjection) await detachFromCursorTab(cursorInjection);
  try {
    cursorInjection = await injectIntoCursorTab(tab.viewId, inspectorScript(proxyOrigin()), channelToken());
  } catch (err) {
    cursorInjection = undefined;
    sidebarProvider.log(`cursor browser: injection failed — ${err}`);
    vscode.window.showWarningMessage(`Couldn't attach to the page in Cursor's browser (${err instanceof Error ? err.message : err}).`);
    return "failed";
  }
  currentPageUrl = tab.url;
  rememberUrl(tab.url);
  sidebarProvider.setBrowserOpen(true, currentPageUrl);
  return "attached";
}

/** Resolve once the page channel has a connected page (or after `ms`). */
function waitForPageConnection(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (bridge?.isConnected) return resolve(true);
      if (Date.now() - start >= ms) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** Command: attach to the Cursor browser tab and say so. */
async function inspectBrowserTab(sidebarProvider: InspectorSidebarProvider): Promise<void> {
  if (await attachToCursorBrowser(sidebarProvider) !== "attached") return;
  const connected = await waitForPageConnection(4000);
  vscode.window.setStatusBarMessage(
    connected ? `$(check) DOM Inspector attached to ${currentPageUrl}` : `$(warning) DOM Inspector injected, waiting for the page to connect…`,
    4000,
  );
}

/** Switch to the HTTP page channel (used by every browser except our own panel). */
function useHttpChannel(sidebarProvider: InspectorSidebarProvider, kind: BrowserKind): void {
  browserKind = kind;
  if (browserPanel) browserPanel.dispose(); // its dispose handler leaves the proxy running (browserKind changed)
  if (!(bridge instanceof HttpPageChannel)) {
    bridge?.dispose();
    bridge = new HttpPageChannel();
    wireUpBridge(bridge, sidebarProvider);
  }
}

function openPanel(sidebarProvider: InspectorSidebarProvider, proxyUrl: string, url: string): void {
  browserKind = "panel";
  if (bridge instanceof HttpPageChannel) {
    bridge.dispose();
    bridge = undefined;
  }
  if (browserPanel) {
    browserPanel.webview.html = panelHtml(proxyUrl, url);
    browserPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "domInspectorBrowser",
    `🌐 ${new URL(url).hostname}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  browserPanel = panel;
  panel.webview.html = panelHtml(proxyUrl, url);
  sidebarProvider.setBrowserOpen(true, currentPageUrl);

  const panelBridge = new BridgeChannel(panel);
  bridge = panelBridge;
  wireUpBridge(panelBridge, sidebarProvider);

  panel.onDidDispose(() => {
    panelBridge.dispose();
    if (bridge === panelBridge) bridge = undefined;
    if (browserPanel === panel) browserPanel = undefined;
    if (browserKind === "panel") {
      stopProxy();
      browserKind = undefined;
      sidebarProvider.setBrowserOpen(false);
      sidebarProvider.setInspecting(false);
    }
  });
}

/** Quick pick for domInspector.browser; reopens the current page in the chosen browser. */
async function chooseBrowser(sidebarProvider: InspectorSidebarProvider): Promise<void> {
  const commands = new Set(await vscode.commands.getCommands(true));
  const current = vscode.workspace.getConfiguration("domInspector").get<string>("browser", "auto");
  type Item = vscode.QuickPickItem & { value: string };
  const auto = resolveBrowser("auto", (id) => commands.has(id));
  const items: Item[] = [
    { label: "Automatic", description: `currently ${BROWSER_LABELS[auto]}`, value: "auto" },
    ...(["integrated", "cursor", "simple", "panel", "external"] as BrowserKind[])
      .filter((k) => resolveBrowser(k, (id) => commands.has(id)) === k)
      .map((k) => ({ label: BROWSER_LABELS[k], value: k as string })),
  ].map((i) => ({ ...i, picked: i.value === current, detail: i.value === current ? "current setting" : undefined }));
  const pick = await vscode.window.showQuickPick(items, { title: "Open inspected pages in…" });
  if (!pick) return;
  await vscode.workspace.getConfiguration("domInspector").update("browser", pick.value, vscode.ConfigurationTarget.Global);
  if (currentPageUrl) await openUrl(sidebarProvider, currentPageUrl);
}

// ---------------------------------------------------------------------------
// Activate inspection mode
// ---------------------------------------------------------------------------

async function activateInspection(sidebarProvider: InspectorSidebarProvider) {
  // No page connected yet: inspect the page open in Cursor's browser, if any.
  if (!bridge || (browserKind !== "panel" && !bridge.isConnected)) {
    const attached = await attachToCursorBrowser(sidebarProvider, true);
    if (attached === "attached" && !(await waitForPageConnection(4000))) {
      sidebarProvider.setInspecting(false);
      vscode.window.showWarningMessage("The page in Cursor's browser didn't connect to DOM Inspector. Reload it and try again; see Output → DOM Inspector for details.");
      return;
    }
    if (attached === "failed") { sidebarProvider.setInspecting(false); return; }
  }
  if (!bridge) {
    sidebarProvider.setInspecting(false);
    vscode.window.showWarningMessage(
      "Open your app in Cursor's browser, or use DOM Inspector: Open URL (⌘⇧U), then pick an element.",
    );
    return;
  }
  if (browserKind !== "panel" && !bridge.isConnected) {
    sidebarProvider.setInspecting(false);
    vscode.window.showWarningMessage(
      `The page isn't connected to DOM Inspector yet. Make sure it's open in the ${BROWSER_LABELS[browserKind ?? "integrated"]} (DOM Inspector: Open URL), then try again.`,
    );
    return;
  }
  sidebarProvider.log("starting inspection");
  if (browserKind === "panel") browserPanel?.reveal(vscode.ViewColumn.One);
  bridge.sendToPage({ type: "start_inspector" });
  sidebarProvider.setInspecting(true);
  sidebarProvider.log("sent start_inspector to page");
}

/**
 * "Detach from current page": remove the inspector from the page (listeners,
 * overlays, connection), stop re-injecting it into a Cursor browser tab, and
 * release the browser: the panel closes, the proxy stops. The sidebar returns
 * to its start screen.
 */
async function detachFromPage(sidebarProvider: InspectorSidebarProvider): Promise<void> {
  const url = currentPageUrl;
  bridge?.sendToPage({ type: "detach" });
  if (cursorInjection) {
    await detachFromCursorTab(cursorInjection);
    cursorInjection = undefined;
  }
  const panel = browserPanel;
  browserKind = undefined;              // so the panel's dispose handler doesn't run its own teardown
  bridge?.dispose();
  bridge = undefined;
  if (panel) panel.dispose();
  // Give the page a moment to receive "detach" over the channel before it closes.
  setTimeout(() => stopProxy(), 300);
  lastPick = null;
  styleChanges = [];
  breadcrumb.clear();
  sidebarProvider.setInspecting(false);
  sidebarProvider.setBrowserOpen(false);
  sidebarProvider.log(`detached from ${url || "the page"}`);
  vscode.window.setStatusBarMessage(`$(debug-disconnect) DOM Inspector detached${url ? ` from ${url}` : ""}`, 3000);
}

/** Stop picking (the sidebar's inspect button, clicked while active). */
function stopInspection(sidebarProvider: InspectorSidebarProvider) {
  bridge?.sendToPage({ type: "stop_inspector" });
  sidebarProvider.setInspecting(false);
  sidebarProvider.log("inspection stopped");
}

// ---------------------------------------------------------------------------
// Bridge message handler
// ---------------------------------------------------------------------------

function wireUpBridge(
  br: PageChannel,
  sidebarProvider: InspectorSidebarProvider,
) {
  let autoSelectPending = false;

  br.onMessage((msg: BridgeMessage) => {
    if (msg.type !== "element_hovered") {
      sidebarProvider.log(`bridge ← ${msg.type}`);
    }
    switch (msg.type) {
      // The panel toolbar's inspect button posts these straight to the page,
      // and copies them to the host so the sidebar button can follow.
      case "start_inspector":
        sidebarProvider.setInspecting(true);
        break;

      case "stop_inspector":
        sidebarProvider.setInspecting(false);
        break;

      case "element_picked":
        sidebarProvider.log(`picked: <${msg.data.tag}> ${msg.data.selector}`);
        if (autoSelectPending) {
          // The automatic <body> selection after load: inspection state is unchanged.
          autoSelectPending = false;
          sidebarProvider.updateElement(msg.data);
        } else if (treeSelectPending) {
          // A node clicked in the Elements tree: a full pick, but quiet when the
          // node has no source (structural nodes like <body> usually don't), and
          // picking mode, if active, carries on.
          treeSelectPending = false;
          handleElementPicked(msg.data, sidebarProvider);
        } else {
          // A pick (click, Enter, or right-click → Inspect element) ends inspection.
          sidebarProvider.setInspecting(false);
          handleElementPicked(msg.data, sidebarProvider);
        }
        break;

      case "element_hovered":
        sidebarProvider.updateHoverPreview(msg.data);
        break;

      case "send_to_ai":
        // The right-click menu stops any active inspection in the page.
        sidebarProvider.setInspecting(false);
        sendElementToAi(msg.data, msg.target, sidebarProvider);
        break;

      case "element_pick_cancelled":
        sidebarProvider.setInspecting(false);
        sidebarProvider.log("inspection cancelled (Escape)");
        break;

      case "children_response":
        sidebarProvider.log(`children: ${msg.children.length} for ${msg.selector}`);
        sidebarProvider.childrenLoaded(msg.selector, msg.children);
        break;

      case "framework_detected":
        sidebarProvider.log(`framework: ${msg.framework}`);
        break;

      case "inspector_ready":
        // A freshly loaded page is never inspecting.
        sidebarProvider.setInspecting(false);
        sidebarProvider.log("inspector ready (page loaded)");
        // Request root-level children to populate the DOM tree
        br.sendToPage({ type: "get_children", selector: "body" });
        // Request full tree starting from <html>
        br.sendToPage({ type: "get_full_tree" });
        // Auto-select <body> to populate sidebar tabs
        autoSelectPending = true;
        br.sendToPage({ type: "inspect_node", selector: "body" });
        // Label the right-click menu with the current AI target
        pushAiTargetToPage();
        break;

      case "full_tree_response": {
        const tree = (msg as { type: 'full_tree_response'; tree: FullTreeNode }).tree;
        function countNodes(n: FullTreeNode): number { let c = 1; for (const ch of n.children) c += countNodes(ch); return c; }
        sidebarProvider.log(`full tree received: ${countNodes(tree)} nodes`);
        sidebarProvider.updateFullTree(tree);
        break;
      }

      default:
        break;
    }
  });

  br.onConnectionLost(() => {
    sidebarProvider.log("connection lost");
    // Only the HTTP channel's signal is real (no page connected any more); the
    // panel's heartbeat fires a false alarm a few seconds after every load.
    if (br instanceof HttpPageChannel) sidebarProvider.setInspecting(false);
    connectionLostMsg?.dispose();
    connectionLostMsg = vscode.window.setStatusBarMessage(
      "$(warning) Inspector connection lost — waiting for page reload…",
    );
  });

  br.onConnectionRestored(() => {
    connectionLostMsg?.dispose();
    connectionLostMsg = undefined;
    vscode.window.setStatusBarMessage("$(check) Inspector reconnected", 3000);
  });
}

// ---------------------------------------------------------------------------
// Handle element_picked
// ---------------------------------------------------------------------------

async function handleElementPicked(
  element: ElementData,
  sidebarProvider: InspectorSidebarProvider,
) {
  // 1. Update the sidebar.
  sidebarProvider.updateElement(element);
  sidebarProvider.log(`element has ${element.children?.length || 0} direct children`);
  if (element.children && element.children.length > 0) {
    sidebarProvider.updateDOMTree(element.children);
  }
  if (element.cssSelectorPath) {
    sidebarProvider.expandToNode(element.cssSelectorPath);
  }

  sidebarProvider.log(`componentInfo: ${element.componentInfo ? element.componentInfo.componentName + " (" + element.componentInfo.framework + ")" : "null"}`);

  // 2. Show the component path in the status bar
  breadcrumb.show(element.componentInfo?.componentPath ?? []);

  // 3. Remember it for the [DOM] commands, and publish it to MCP clients
  rememberPick(element);
  publishSelection(element, currentPageUrl || "http://localhost", (m) => sidebarProvider.log(m));
}

function rememberPick(element: ElementData): void {
  const sameElement = lastPick && lastPick.element.cssSelectorPath === element.cssSelectorPath;
  if (!sameElement) styleChanges = [];
  lastPick = { element };
}

type SendMode = "primary" | "pick" | "clipboard";
interface ElementTask { task?: string; prompt: string }

/**
 * Send an element to an AI assistant: write a Markdown snapshot of it (with
 * an optional task) and hand it to the chosen target.
 * Falls back to the clipboard when the target can't take it.
 */
async function sendElementToAi(
  element: ElementData,
  mode: SendMode,
  sidebarProvider: InspectorSidebarProvider,
  task: ElementTask = { prompt: "Here is a DOM element from my running app (snapshot attached)." },
): Promise<void> {
  let target: AiTargetId;
  if (mode === "clipboard") target = "clipboard";
  else if (mode === "pick") {
    const chosen = await chooseAiTarget();
    if (!chosen) return;
    target = chosen;
  } else target = primaryTarget();

  const label = elementLabel(element);
  sidebarProvider.log(`send to ${TARGET_LABELS[target]}: <${label}>`);
  sidebarProvider.updateElement(element);

  rememberPick(element);
  publishSelection(element, currentPageUrl || "http://localhost", (m) => sidebarProvider.log(m));

  const markdown = buildElementMarkdown(element, {
    pageUrl: currentPageUrl || "http://localhost",
    pickedAt: new Date().toISOString(),
    task: task.task,
  });

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const dir = root
    ? path.join(root, SNAPSHOT_DIR)
    : path.join(extensionContext.globalStorageUri.fsPath, "snapshots");

  let file: string;
  try {
    file = writeSnapshot(dir, snapshotFileName(element.tag, new Date()), markdown);
  } catch (err) {
    sidebarProvider.log(`snapshot write failed: ${err}`);
    await vscode.env.clipboard.writeText(markdown);
    vscode.window.showWarningMessage("Couldn't write the element snapshot. Its context was copied to the clipboard; paste it into your AI chat.");
    return;
  }

  try {
    await sendToTarget(target, { snapshotFile: file, markdown, prompt: task.prompt });
    sidebarProvider.log(`sent to ${TARGET_LABELS[target]} (${file})`);
    vscode.window.setStatusBarMessage(
      target === "clipboard" ? `$(clippy) <${label}> copied as Markdown` : `$(sparkle) <${label}> added to ${TARGET_LABELS[target]}`,
      4000,
    );
  } catch (err) {
    sidebarProvider.log(`send to ${TARGET_LABELS[target]} failed: ${err}`);
    await vscode.env.clipboard.writeText(markdown);
    const action = await vscode.window.showWarningMessage(
      `Couldn't send to ${TARGET_LABELS[target]} (${err instanceof Error ? err.message : err}). The element context was copied to the clipboard.`,
      "Choose Another AI…",
    );
    if (action) await chooseAiTarget();
  }
}

type TaskKind = "select" | "analyze" | "apply-styles" | "remove";

/** [DOM] commands: send the last picked element with a task to the current AI target. */
async function runElementTask(kind: TaskKind, sidebarProvider: InspectorSidebarProvider): Promise<void> {
  if (!lastPick) {
    vscode.window.showWarningMessage("Pick an element first: Inspect Element, or right-click it in the DOM Inspector browser.");
    return;
  }
  let task: ElementTask;
  switch (kind) {
    case "select":
      task = { prompt: "Here is a DOM element from my running app (snapshot attached)." };
      break;
    case "analyze":
      task = {
        prompt: "Analyze the attached DOM element (see its Task section).",
        task: [
          "Analyze this element and provide:",
          "",
          "1. **Purpose:** what it does in the UI.",
          "2. **Accessibility:** missing ARIA attributes, contrast, keyboard navigation, semantic HTML.",
          "3. **Playwright locator:** a stable one, preferring role- or test-id-based locators.",
          "4. **Cypress locator:** a stable selector strategy.",
          "5. **Fragile patterns:** deeply nested positional selectors, generated class names, etc.",
          "6. **Improvements:** markup or attribute changes that improve testability and accessibility.",
        ].join("\n"),
      };
      break;
    case "apply-styles": {
      if (styleChanges.length === 0) {
        vscode.window.showWarningMessage("No style changes recorded. Edit styles in the DOM Inspector Styles tab first.");
        return;
      }
      const list = styleChanges.map((c) => `- \`${c.property}\`: \`${c.oldValue || "(none)"}\` → \`${c.newValue}\``).join("\n");
      task = {
        prompt: "Apply the style changes listed in the attached DOM element snapshot to the source code.",
        task: [
          "Apply these CSS changes, made live in the browser, to the source code of this element:",
          "",
          list,
          "",
          "- Edit the element's styles where they are defined (Tailwind classes, CSS/SCSS, CSS modules, styled-components, or inline styles).",
          "- If the project uses Tailwind, use the matching utility classes.",
          "- Only change the properties listed; keep existing formatting and conventions.",
        ].join("\n"),
      };
      break;
    }
    case "remove":
      task = {
        prompt: "Remove the attached DOM element from the source code.",
        task: [
          "Remove this element and its children from the source code.",
          "",
          "- Clean up imports, variables and styles that were only used by it.",
          "- Keep the surrounding structure and formatting.",
          "- Point out any layout adjustments the removal needs.",
        ].join("\n"),
      };
      break;
  }
  await sendElementToAi(lastPick.element, "primary", sidebarProvider, task);
}

/**
 * Record a style edit for "[DOM] Apply styles" (coalesced per selector+property,
 * keeping the original value) and forward it to the MCP bridge.
 */
function recordStyleChange(selector: string, property: string, value: string): void {
  let change = styleChanges.find((c) => c.selector === selector && c.property === property);
  if (change) {
    change.newValue = value;
  } else {
    const computed = lastPick?.element.allComputedStyles as Record<string, unknown> | undefined;
    const all = (computed && typeof computed.all === "object" ? computed.all : computed) as Record<string, string> | undefined;
    change = { selector, property, oldValue: all?.[property] ?? "", newValue: value };
    styleChanges.push(change);
  }
  publishStyleChange(change);
}

export function deactivate() {
  if (cursorInjection) void detachFromCursorTab(cursorInjection);
  bridge?.dispose();
  bridge = undefined;
  breadcrumb.dispose();
  stopProxy();
}
