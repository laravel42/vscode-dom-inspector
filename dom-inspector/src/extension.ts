import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { startProxy, stopProxy } from "./proxy";
import { BridgeChannel } from "./bridge";
import { SourceMapper } from "./source-mapper";
import { InspectorSidebarProvider } from "./sidebar";
import { ComponentBreadcrumb } from "./breadcrumb";
import { BridgeMessage, ElementData, ComponentPathEntry, FullTreeNode } from "./types";

let browserPanel: vscode.WebviewPanel | undefined;
let bridge: BridgeChannel | undefined;

const sourceMapper = new SourceMapper();
const breadcrumb = new ComponentBreadcrumb();

let connectionLostMsg: vscode.Disposable | undefined;
let inspecting = false;

const MAX_URL_HISTORY = 50;
let urlHistory: string[] = [];
let extensionContext: vscode.ExtensionContext;
let currentPageUrl = "";

/**
 * Ensures the .kiro/settings/mcp.json includes the dom-inspector MCP server
 * pointing to the bundled MCP server inside this extension.
 */
function ensureMcpConfig(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  const mcpServerPath = path.join(context.extensionPath, "mcp-server", "index.js");

  for (const folder of workspaceFolders) {
    const kiroDir = path.join(folder.uri.fsPath, ".kiro", "settings");
    const mcpConfigPath = path.join(kiroDir, "mcp.json");

    try {
      let config: { mcpServers?: Record<string, unknown> } = { mcpServers: {} };

      if (fs.existsSync(mcpConfigPath)) {
        const existing = JSON.parse(fs.readFileSync(mcpConfigPath, "utf-8"));
        config = existing;
        if (!config.mcpServers) {
          config.mcpServers = {};
        }
        // Skip if dom-inspector is already configured
        if (config.mcpServers["dom-inspector"]) {
          // Update the path in case extension was updated
          const entry = config.mcpServers["dom-inspector"] as Record<string, unknown>;
          const args = entry.args as string[] | undefined;
          if (args && args[0] !== mcpServerPath) {
            args[0] = mcpServerPath;
            fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2) + "\n");
            output.appendLine(`Updated dom-inspector MCP server path in ${mcpConfigPath}`);
          }
          continue;
        }
      }

      // Add dom-inspector MCP server entry
      config.mcpServers!["dom-inspector"] = {
        command: "node",
        args: [mcpServerPath],
        env: {
          DOM_INSPECTOR_PORT: "3100",
        },
        disabled: false,
        autoApprove: [],
      };

      fs.mkdirSync(kiroDir, { recursive: true });
      fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2) + "\n");
      output.appendLine(`Created MCP config at ${mcpConfigPath}`);
    } catch (err) {
      output.appendLine(`Failed to write MCP config: ${err}`);
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  urlHistory = context.globalState.get<string[]>("domInspector.urlHistory", []);
  const output = vscode.window.createOutputChannel("DOM Inspector");
  output.appendLine("DOM Inspector activated");

  // Ensure MCP config exists for Kiro integration
  ensureMcpConfig(context, output);

  // Register chat participant to get language model access
  const participant = vscode.chat.createChatParticipant("dom-inspector.chat", async (request, _context, response, _token) => {
    response.markdown("Use the DOM Inspector sidebar to pick elements and ask questions about them.");
  });
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "inspect.svg");
  context.subscriptions.push(participant);

  // --- Sidebar provider ---
  const sidebarProvider = new InspectorSidebarProvider({
    onNodeClicked(selector: string) {
      if (bridge) {
        bridge.sendToPage({ type: "highlight_element", selector });
        bridge.sendToPage({ type: "scroll_to_element", selector });
        bridge.sendToPage({ type: "inspect_node", selector });
      }
      navigateSourceForSelector(selector);
    },
    onRequestChildren(selector: string) {
      if (bridge) {
        bridge.sendToPage({ type: "get_children", selector });
      }
    },
    onOpenUrl(url: string) {
      openUrl(sidebarProvider, url);
    },
    onForceState(selector: string, state: string, enabled: boolean) {
      if (bridge) bridge.sendToPage({ type: "force_state", selector, state, enabled });
    },
    onSetStyle(selector: string, property: string, value: string) {
      if (bridge) bridge.sendToPage({ type: "set_style", selector, property, value });
      // Publish style change to MCP bridge
      publishStyleChange(selector, property, value);
    },
    onToggleStyle(selector: string, property: string, enabled: boolean) {
      if (bridge) bridge.sendToPage({ type: "toggle_style", selector, property, enabled });
    },
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      InspectorSidebarProvider.viewType,
      sidebarProvider,
    ),
  );

  // Send initial URL history to sidebar when it becomes visible
  sidebarProvider.onReady(() => {
    sidebarProvider.updateUrlHistory(urlHistory);
  });

  // --- Breadcrumb segment click handler ---
  breadcrumb.onSegmentClicked((component: ComponentPathEntry) => {
    if (component.selector && bridge) {
      bridge.sendToPage({ type: "highlight_element", selector: component.selector });
      bridge.sendToPage({ type: "scroll_to_element", selector: component.selector });
    }
    if (component.sourceFile) {
      openSourceFile(component.sourceFile, 1);
    }
  });

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand("domInspector.openUrl", () => openUrl(sidebarProvider)),
    vscode.commands.registerCommand("domInspector.inspectElement", () => activateInspection(sidebarProvider)),
    vscode.commands.registerCommand("domInspector.selectNode", () => sendMcpPromptToChat("select")),
    vscode.commands.registerCommand("domInspector.analyzeNode", () => sendMcpPromptToChat("analyze")),
    vscode.commands.registerCommand("domInspector.applyStyles", () => sendMcpPromptToChat("apply-styles")),
    vscode.commands.registerCommand("domInspector.removeNode", () => sendMcpPromptToChat("remove")),
  );

  context.subscriptions.push({ dispose: () => breadcrumb.dispose() });
}

function getCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.HOME || "/";
}

// ---------------------------------------------------------------------------
// Open URL — create browser panel with proxy
// ---------------------------------------------------------------------------

async function openUrl(sidebarProvider: InspectorSidebarProvider, directUrl?: string) {
  let url = directUrl;
  if (!url) {
    url = await vscode.window.showInputBox({
      prompt: "Enter URL to open",
      placeHolder: "http://localhost:5173",
      value: "http://localhost:5173",
    });
  }
  if (!url) return;

  // Save to history
  urlHistory = urlHistory.filter(u => u !== url);
  urlHistory.unshift(url!);
  if (urlHistory.length > MAX_URL_HISTORY) urlHistory.length = MAX_URL_HISTORY;
  extensionContext.globalState.update("domInspector.urlHistory", urlHistory);
  sidebarProvider.updateUrlHistory(urlHistory);

  sidebarProvider.log(`opening ${url}`);
  currentPageUrl = url;
  const proxyPort = await startProxy(url);
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  sidebarProvider.log(`proxy on :${proxyPort}`);

  if (browserPanel) {
    browserPanel.webview.html = getBrowserHtml(browserPanel.webview, proxyUrl, url);
    browserPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  browserPanel = vscode.window.createWebviewPanel(
    "domInspectorBrowser",
    `🌐 ${new URL(url).hostname}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  browserPanel.webview.html = getBrowserHtml(browserPanel.webview, proxyUrl, url);
  sidebarProvider.setBrowserOpen(true);

  // Initialize BridgeChannel
  bridge = new BridgeChannel(browserPanel);
  wireUpBridge(bridge, sidebarProvider);

  browserPanel.onDidDispose(() => {
    bridge?.dispose();
    bridge = undefined;
    browserPanel = undefined;
    inspecting = false;
    stopProxy();
    sidebarProvider.setBrowserOpen(false);
  });
}

// ---------------------------------------------------------------------------
// Activate inspection mode
// ---------------------------------------------------------------------------

function activateInspection(sidebarProvider: InspectorSidebarProvider) {
  if (!browserPanel || !bridge) {
    vscode.window.showWarningMessage(
      "Open a URL first (⌘⇧U), then pick an element.",
    );
    return;
  }
  sidebarProvider.log("starting inspection");
  browserPanel.reveal(vscode.ViewColumn.One);
  bridge.sendToPage({ type: "start_inspector" });
  sidebarProvider.log("sent start_inspector to page");
  inspecting = true;
}

// ---------------------------------------------------------------------------
// Bridge message handler
// ---------------------------------------------------------------------------

function wireUpBridge(
  br: BridgeChannel,
  sidebarProvider: InspectorSidebarProvider,
) {
  let autoSelectPending = false;

  br.onMessage((msg: BridgeMessage) => {
    if (msg.type !== "element_hovered") {
      sidebarProvider.log(`bridge ← ${msg.type}`);
    }
    switch (msg.type) {
      case "element_picked":
        inspecting = false;
        sidebarProvider.log(`picked: <${msg.data.tag}> ${msg.data.selector}`);
        if (autoSelectPending) {
          autoSelectPending = false;
          sidebarProvider.updateElement(msg.data);
        } else {
          handleElementPicked(msg.data, sidebarProvider);
        }
        break;

      case "element_hovered":
        sidebarProvider.updateHoverPreview(msg.data);
        break;

      case "element_pick_cancelled":
        inspecting = false;
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
        sidebarProvider.log("inspector ready (page loaded)");
        // Request root-level children to populate the DOM tree
        br.sendToPage({ type: "get_children", selector: "body" });
        // Request full tree starting from <html>
        br.sendToPage({ type: "get_full_tree" });
        // Auto-select <body> to populate sidebar tabs
        autoSelectPending = true;
        br.sendToPage({ type: "inspect_node", selector: "body" });
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
  const cwd = getCwd();

  // 1. Run SourceMapper
  const source = await sourceMapper.resolve(element, cwd);
  sidebarProvider.log(`source: ${source ? source.strategy + " → " + source.filePath + ":" + source.line : "not found"}`);
  sidebarProvider.log(`componentInfo: ${element.componentInfo ? element.componentInfo.componentName + " (framework: " + element.componentInfo.framework + ", sourceFile: " + element.componentInfo.sourceFile + ")" : "null"}`);

  // 2. Open file side by side and highlight line
  if (source) {
    const fullPath = path.resolve(cwd, source.filePath);
    await openSourceFile(fullPath, source.line);
  } else {
    vscode.window.showWarningMessage(
      `Could not find source for <${element.tag}> "${(element.text || "").slice(0, 40)}"`,
    );
  }

  // 3. Update sidebar
  sidebarProvider.updateElement(element, source ? source.filePath : undefined);
  sidebarProvider.log(`element has ${element.children?.length || 0} direct children`);
  if (element.children && element.children.length > 0) {
    sidebarProvider.updateDOMTree(element.children);
  }
  if (element.cssSelectorPath) {
    sidebarProvider.expandToNode(element.cssSelectorPath);
  }

  // 4. Update breadcrumb
  const components: ComponentPathEntry[] = [];
  if (element.componentInfo?.componentPath) {
    for (const name of element.componentInfo.componentPath) {
      components.push({
        name,
        sourceFile: null,
        selector: null,
      });
    }
    // Enrich the last entry with source info if available
    if (components.length > 0 && element.componentInfo.sourceFile) {
      components[components.length - 1].sourceFile =
        element.componentInfo.sourceFile;
    }
  }
  breadcrumb.show(components);

  // 5. Publish to MCP bridge so Kiro can access via #selected-dom-node
  publishToMcpBridge(element, source, sidebarProvider);
}

/**
 * POST the picked element to the local MCP HTTP bridge.
 * Reads the port from a well-known temp file written by the MCP server.
 * Fire-and-forget — failures are logged but don't block the UI.
 */
function publishToMcpBridge(
  element: ElementData,
  source: { filePath: string; line: number } | null,
  sidebarProvider?: InspectorSidebarProvider,
): void {
  const http = require("http");
  const port = 3100;

  const payload: Record<string, unknown> = {
    url: currentPageUrl || "http://localhost",
    tagName: element.tag,
    id: element.id || undefined,
    classes: element.classNames?.length ? element.classNames : undefined,
    text: element.text || undefined,
    selector: element.selector || undefined,
    xpath: element.xpath || undefined,
    attributes: element.attrs && Object.keys(element.attrs).length ? element.attrs : undefined,
    outerHTML: element.outerSnippet || undefined,
  };

  if (element.componentInfo?.componentPath?.length) {
    payload.nearbyContext = `Component: ${element.componentInfo.componentPath.join(" > ")}`;
  }

  const role = element.attrs?.role;
  const ariaLabel = element.attrs?.["aria-label"];
  if (role) payload.role = role;
  if (ariaLabel) payload.ariaLabel = ariaLabel;

  if (source) {
    payload.title = `${source.filePath}:${source.line}`;
  }

  const body = JSON.stringify(payload);
  sidebarProvider?.log(`mcp: POST :${port}/selection (${body.length} bytes)`);

  const req = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: "/selection",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 2000,
    },
    (res: { statusCode?: number; on: Function }) => {
      let data = "";
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => {
        sidebarProvider?.log(`mcp: response ${res.statusCode} ${data.slice(0, 100)}`);
      });
    },
  );
  req.on("error", (err: Error) => {
    sidebarProvider?.log(`mcp: POST error — ${err.message}`);
  });
  req.write(body);
  req.end();
}

/**
 * POST a style change to the MCP bridge so [DOM] Apply styles can use it.
 */
function publishStyleChange(selector: string, property: string, value: string): void {
  const http = require("http");
  const port = 3100;

  const body = JSON.stringify({ selector, property, newValue: value });
  const req = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: "/style-change",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 2000,
    },
    (res: { on: Function }) => { res.on("data", () => {}); },
  );
  req.on("error", () => {});
  req.write(body);
  req.end();
}

/**
 * Fetch context from the MCP bridge and open Kiro chat with it.
 */
async function sendMcpPromptToChat(action: "select" | "analyze" | "apply-styles" | "remove"): Promise<void> {
  const http = require("http");
  const port = 3100;

  let selection: any;
  try {
    const json: any = await new Promise((resolve, reject) => {
      const req = http.get(
        { hostname: "127.0.0.1", port, path: "/selection", timeout: 2000 },
        (res: { on: Function }) => {
          let data = "";
          res.on("data", (chunk: string) => { data += chunk; });
          res.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error("bad json")); } });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    });
    selection = json?.selection;
  } catch {
    vscode.window.showWarningMessage("DOM Inspector MCP server is not running. Start it first.");
    return;
  }

  if (!selection) {
    vscode.window.showWarningMessage("No DOM element selected. Pick an element first (⌘⇧I).");
    return;
  }

  const node = selection.node;
  const styles: Array<{ property: string; oldValue: string; newValue: string }> = selection.styleChanges || [];

  // Build context block
  const lines: string[] = [];
  lines.push(`**Element:** \`<${node.tagName}>\``);
  if (node.selector) lines.push(`**Selector:** \`${node.selector}\``);
  if (node.classes?.length) lines.push(`**Classes:** \`${node.classes.join(" ")}\``);
  if (node.text) lines.push(`**Text:** "${node.text.slice(0, 100)}"`);
  if (node.title) lines.push(`**Source:** ${node.title}`);
  if (node.outerHTML) lines.push(`\`\`\`html\n${node.outerHTML.slice(0, 500)}\n\`\`\``);
  const context = lines.join("\n");

  let query = "";

  switch (action) {
    case "select":
      query = context;
      break;

    case "analyze":
      query = [
        "Analyze this DOM element for accessibility, testability, and purpose:",
        "",
        context,
        "",
        "Provide: purpose, accessibility concerns, Playwright locator, Cypress locator, fragile patterns, and improvement suggestions.",
      ].join("\n");
      break;

    case "apply-styles":
      if (styles.length === 0) {
        vscode.window.showWarningMessage("No style changes recorded. Edit styles in the DOM Inspector first.");
        return;
      }
      const changeList = styles.map(
        (s: any) => `- \`${s.property}\`: \`${s.oldValue || "(none)"}\` → \`${s.newValue}\``
      ).join("\n");
      query = [
        "Apply these CSS style changes to the source code:",
        "",
        context,
        "",
        "### Style Changes",
        changeList,
        "",
        "Convert to Tailwind classes if the project uses Tailwind. Only modify the listed properties.",
      ].join("\n");
      break;

    case "remove":
      query = [
        "Remove this DOM element from the source code:",
        "",
        context,
        "",
        "Clean up unused imports/variables/styles. Note any layout adjustments needed.",
      ].join("\n");
      break;
  }

  try {
    // Save clipboard, paste into chat, restore
    const saved = await vscode.env.clipboard.readText();
    await vscode.env.clipboard.writeText(query);
    await vscode.commands.executeCommand("workbench.action.chat.open");
    // Small delay to let the chat panel focus
    await new Promise(r => setTimeout(r, 300));
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
    // Restore original clipboard
    await vscode.env.clipboard.writeText(saved);
  } catch {
    await vscode.env.clipboard.writeText(query);
    vscode.window.showInformationMessage("DOM context copied to clipboard — paste it into the chat.");
  }
}

// ---------------------------------------------------------------------------
// Source navigation helpers
// ---------------------------------------------------------------------------

async function openSourceFile(
  filePathOrAbsolute: string,
  line: number,
): Promise<void> {
  try {
    const absPath = path.isAbsolute(filePathOrAbsolute)
      ? filePathOrAbsolute
      : path.resolve(getCwd(), filePathOrAbsolute);

    const fileUri = vscode.Uri.file(absPath);
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const lineIdx = Math.max(0, line - 1);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Two,
      preserveFocus: false,
    });

    // Find the closing tag to select the full element range
    const endLine = findClosingTagLine(doc, lineIdx);

    const startPos = new vscode.Position(lineIdx, 0);
    const endLineText = doc.lineAt(endLine).text;
    const endPos = new vscode.Position(endLine, endLineText.length);
    const range = new vscode.Range(startPos, endPos);

    editor.selection = new vscode.Selection(startPos, endPos);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

    const decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(88, 166, 255, 0.15)",
      border: "1px solid rgba(88, 166, 255, 0.4)",
      isWholeLine: true,
    });
    editor.setDecorations(decoration, [range]);
    setTimeout(() => decoration.dispose(), 10000);
  } catch {
    // File may not exist or be unreadable
  }
}

/**
 * Starting from a line with an opening tag, find the line with the matching
 * closing tag by tracking bracket depth. Handles self-closing tags, JSX
 * fragments, and multi-line elements.
 */
function findClosingTagLine(doc: vscode.TextDocument, startLine: number): number {
  const startText = doc.lineAt(startLine).text;

  // Self-closing tag on the same line: <input ... /> or <br />
  if (/\/>\s*$/.test(startText)) {
    return startLine;
  }

  // Extract the tag name from the opening line
  const tagMatch = startText.match(/<([a-zA-Z][a-zA-Z0-9.]*)/);
  if (!tagMatch) {
    return startLine;
  }

  const tagName = tagMatch[1];
  const maxScan = Math.min(doc.lineCount, startLine + 200);

  // First check: is this a self-closing tag split across lines?
  // Scan forward for /> before any closing tag
  for (let i = startLine + 1; i < maxScan; i++) {
    const line = doc.lineAt(i).text;
    if (/\/>\s*$/.test(line)) {
      return i;
    }
    // If we hit a closing tag or a new opening tag at the same indent, stop
    if (new RegExp(`</${escapeRegex(tagName)}\\s*>`).test(line)) {
      break;
    }
    // If we hit > without /, this tag's opening is done — look for closing tag
    if (/[^/]>\s*$/.test(line) || /^[^<]*>\s*$/.test(line)) {
      break;
    }
  }

  // Paired tag: track depth to find matching close
  let depth = 0;
  for (let i = startLine; i < maxScan; i++) {
    const lineText = doc.lineAt(i).text;

    const opens = lineText.match(new RegExp(`<${escapeRegex(tagName)}[\\s>/]`, 'g')) || [];
    const selfCloses = lineText.match(new RegExp(`<${escapeRegex(tagName)}[^>]*/\\s*>`, 'g')) || [];
    const closes = lineText.match(new RegExp(`</${escapeRegex(tagName)}\\s*>`, 'g')) || [];

    depth += opens.length - selfCloses.length - closes.length;

    if (depth <= 0 && i >= startLine) {
      return i;
    }
  }

  return startLine;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, (ch) => '\\' + ch);
}

async function navigateSourceForSelector(selector: string): Promise<void> {
  const cwd = getCwd();
  // Build a minimal ElementData to pass to source mapper
  const minimalElement: ElementData = {
    selector,
    tag: "",
    id: null,
    classNames: [],
    attrs: {},
    text: "",
    outerSnippet: "",
    domPath: [],
    children: [],
    boxModel: {
      content: { x: 0, y: 0, width: 0, height: 0 },
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      border: { top: 0, right: 0, bottom: 0, left: 0 },
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    },
    computedStyles: {
      display: "",
      position: "",
      color: "",
      backgroundColor: "",
      fontSize: "",
      fontFamily: "",
      width: "",
      height: "",
      boxSizing: "",
    },
    xpath: "",
    cssSelectorPath: "",
    allComputedStyles: {},
    componentInfo: null,
  };

  const source = await sourceMapper.resolve(minimalElement, cwd);
  if (source) {
    const fullPath = path.resolve(cwd, source.filePath);
    await openSourceFile(fullPath, source.line);
  }
}

// ---------------------------------------------------------------------------
// Browser panel webview HTML with typed BridgeChannel relay
// ---------------------------------------------------------------------------

function getBrowserHtml(webview: vscode.Webview, proxyUrl: string, originalUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #0d1117; }
    body { display: flex; flex-direction: column; height: 100vh; }
    .toolbar {
      display: flex; align-items: center; gap: 4px; padding: 6px 8px;
      background: #161b22; border-bottom: 1px solid #30363d; flex-shrink: 0;
    }
    .toolbar input {
      flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 4px;
      color: #e6edf3; padding: 6px 10px; font: 13px/1 system-ui; outline: none;
      min-width: 0;
    }
    .toolbar input:focus { border-color: #58a6ff; }
    .tb {
      width: 32px; height: 32px;
      display: inline-flex; align-items: center; justify-content: center;
      background: #21262d; border: 1px solid #30363d; border-radius: 6px;
      color: #e6edf3; cursor: pointer; font-size: 16px;
      flex-shrink: 0; transition: background 0.12s, border-color 0.12s, color 0.12s;
    }
    .tb:hover { background: #30363d; }
    .tb.inspecting {
      background: #0d4429; border-color: #3fb950; color: #3fb950;
      animation: pulse 1.5s infinite;
    }
    .tb svg { width: 18px; height: 18px; fill: currentColor; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }
    iframe { flex: 1; width: 100%; border: none; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button class="tb" id="reload" title="Reload page">
      <svg viewBox="0 0 16 16"><path d="M13.5 2a.5.5 0 0 0-.5.5V5H10a.5.5 0 0 0 0 1h3.5a.5.5 0 0 0 .5-.5V2.5a.5.5 0 0 0-.5-.5zM8 3a5 5 0 0 0-4.55 2.93.5.5 0 1 0 .91.42A4 4 0 1 1 4 9.52a.5.5 0 1 0-.71.71A5 5 0 1 0 8 3z"/></svg>
    </button>
    <input id="url" type="text" value="${originalUrl}" readonly>
    <button class="tb" id="inspect" title="Inspect element (⌘⇧I)">
      <svg viewBox="0 0 16 16"><path d="M1 1v14h14V1H1zm1 1h12v12H2V2zm2 2v2h1V5h1V4H4zm5 0v1h1v1h1V4H9zM7 7v2h2V7H7zm-3 3v2h2v-1H5v-1H4zm6 0v1h-1v1h2v-2h-1z"/></svg>
    </button>
  </div>
  <iframe id="frame" src="${proxyUrl}"></iframe>
  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      const frame = document.getElementById('frame');
      const inspectBtn = document.getElementById('inspect');

      // ---- Typed BridgeChannel relay ----
      // All BridgeMessage types that flow Extension Host → Inspector Script (page)
      const TO_PAGE_TYPES = [
        'start_inspector', 'stop_inspector',
        'highlight_element', 'scroll_to_element', 'get_children', 'get_full_tree', 'inspect_node',
        'force_state', 'set_style', 'toggle_style'
      ];
      // All BridgeMessage types that flow Inspector Script (page) → Extension Host
      const TO_HOST_TYPES = [
        'element_hovered', 'element_picked', 'element_pick_cancelled',
        'children_response', 'framework_detected', 'inspector_ready', 'full_tree_response'
      ];

      let isInspecting = false;

      function setInspecting(active) {
        isInspecting = active;
        inspectBtn.classList.toggle('inspecting', active);
      }

      // ---- Messages from Extension Host → forward to iframe (page) ----
      window.addEventListener('message', function(ev) {
        const msg = ev.data;
        if (!msg || typeof msg.type !== 'string') return;
        console.log('[webview] message received:', msg.type, 'from origin:', ev.origin);

        // If it's a message type destined for the page, relay to iframe
        if (TO_PAGE_TYPES.indexOf(msg.type) !== -1) {
          if (msg.type === 'start_inspector') setInspecting(true);
          if (msg.type === 'stop_inspector') setInspecting(false);
          try { frame.contentWindow.postMessage(msg, '*'); } catch(e) {}
          return;
        }

        // If it's a message type from the page (via iframe postMessage), relay to extension host
        if (TO_HOST_TYPES.indexOf(msg.type) !== -1) {
          if (msg.type === 'element_picked' || msg.type === 'element_pick_cancelled') {
            setInspecting(false);
          }
          vscode.postMessage(msg);
          return;
        }
      });

      // ---- Toolbar buttons ----
      document.getElementById('reload').onclick = function() { frame.src = frame.src; };

      inspectBtn.onclick = function() {
        console.log('[webview] inspect button clicked, isInspecting:', isInspecting);
        if (isInspecting) {
          try { frame.contentWindow.postMessage({ type: 'stop_inspector' }, '*'); } catch(e) { console.error('[webview] postMessage failed:', e); }
          vscode.postMessage({ type: 'stop_inspector' });
          setInspecting(false);
        } else {
          try { frame.contentWindow.postMessage({ type: 'start_inspector' }, '*'); } catch(e) { console.error('[webview] postMessage failed:', e); }
          vscode.postMessage({ type: 'start_inspector' });
          setInspecting(true);
        }
      };
    })();
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

export function deactivate() {
  bridge?.dispose();
  bridge = undefined;
  breadcrumb.dispose();
  stopProxy();
}
