import * as vscode from "vscode";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { ElementData } from "../types";
import { MCP_CLIENTS, McpServerSpec, applyMcpConfig, hostMcpClient } from "./mcp-config";

/**
 * The editor side of MCP: registering the bundled server with AI clients, and
 * publishing picks and style edits to its local HTTP bridge
 * (src/mcp-server: POST /selection and /style-change).
 */

export interface McpHost {
  extensionPath: string;
  globalStoragePath: string;
  output: vscode.OutputChannel;
}

/** Port of the MCP server's HTTP bridge (domInspector.mcp.port). */
export function mcpPort(): number {
  return vscode.workspace.getConfiguration("domInspector").get<number>("mcp.port", 3100);
}

function mcpServerSpec(host: McpHost): McpServerSpec {
  return {
    command: "node",
    args: [path.join(host.extensionPath, "mcp-server", "index.js")],
    env: { DOM_INSPECTOR_PORT: String(mcpPort()) },
  };
}

function mcpPaths(host: McpHost, workspace?: string) {
  return { workspace, home: os.homedir(), globalStorage: host.globalStoragePath };
}

/**
 * Register the bundled MCP server with the *current editor's* own AI
 * (Kiro → .kiro/settings/mcp.json, Cursor → .cursor/mcp.json,
 * VS Code → .vscode/mcp.json). Other clients: "Set Up MCP for AI Tools…".
 */
export function autoConfigureMcp(host: McpHost): void {
  if (!vscode.workspace.getConfiguration("domInspector").get<boolean>("mcp.autoConfigure", true)) return;
  const hostId = hostMcpClient(vscode.env.appName || "");
  const client = MCP_CLIENTS.find((c) => c.id === hostId);
  if (!client) return;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const r = applyMcpConfig(client, mcpServerSpec(host), mcpPaths(host, folder.uri.fsPath));
    if (r.status !== "unchanged") host.output.appendLine(`MCP (${client.label}): ${r.status} ${r.file ?? ""} ${r.message ?? ""}`);
  }
}

/** "Set Up MCP for AI Tools…": register the server with the clients the user picks. */
export async function setupMcpForAiTools(host: McpHost): Promise<void> {
  const hostId = hostMcpClient(vscode.env.appName || "");
  const folders = vscode.workspace.workspaceFolders ?? [];
  type Item = vscode.QuickPickItem & { clientId?: string; copy?: boolean };
  const items: Item[] = MCP_CLIENTS.map((c) => ({
    label: c.label,
    description: c.scope === "global" ? "user-wide config" : folders.length ? "this workspace" : "needs an open folder",
    detail: c.file(mcpPaths(host, folders[0]?.uri.fsPath)) ?? undefined,
    picked: c.id === hostId,
    clientId: c.id,
  }));
  items.push({ label: "$(clippy) Copy server config as JSON", description: "for any other MCP client", copy: true });
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: "Register the DOM Inspector MCP server with…",
    placeHolder: "Select the AI tools you use",
  });
  if (!picked || picked.length === 0) return;

  const lines: string[] = [];
  for (const item of picked) {
    if (item.copy) {
      await vscode.env.clipboard.writeText(JSON.stringify({ mcpServers: { "dom-inspector": mcpServerSpec(host) } }, null, 2));
      lines.push("JSON config copied to the clipboard");
      continue;
    }
    const client = MCP_CLIENTS.find((c) => c.id === item.clientId)!;
    const targets = client.scope === "workspace" ? folders.map((f) => f.uri.fsPath) : [undefined];
    if (targets.length === 0) { lines.push(`${client.label}: skipped (open a folder first)`); continue; }
    for (const ws of targets) {
      const r = applyMcpConfig(client, mcpServerSpec(host), mcpPaths(host, ws));
      lines.push(`${client.label}: ${r.status}${r.file ? ` ${r.file}` : ""}${r.message ? ` (${r.message})` : ""}`);
    }
  }
  for (const l of lines) host.output.appendLine(`MCP setup — ${l}`);
  const failed = lines.filter((l) => /: error/.test(l));
  const msg = failed.length
    ? `MCP setup finished with ${failed.length} error(s). See Output → DOM Inspector.`
    : `MCP server registered (${picked.length} item${picked.length > 1 ? "s" : ""}). Restart or reload the AI tools to pick it up.`;
  (failed.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(msg, "Show Output").then((a) => {
    if (a) host.output.show();
  });
}

export interface StyleChange { selector: string; property: string; oldValue: string; newValue: string }

/**
 * POST the picked element to the MCP bridge. Fire-and-forget: without a
 * running MCP server the request fails and is only logged.
 */
export function publishSelection(
  element: ElementData,
  pageUrl: string,
  log?: (message: string) => void,
): void {
  const payload: Record<string, unknown> = {
    url: pageUrl,
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

  const body = JSON.stringify(payload);
  const port = mcpPort();
  log?.(`mcp: POST :${port}/selection (${body.length} bytes)`);
  postJson(port, "/selection", body,
    (status, data) => log?.(`mcp: response ${status} ${data.slice(0, 100)}`),
    (err) => log?.(`mcp: POST error — ${err.message}`));
}

/** POST one recorded style edit to the MCP bridge (failures are ignored). */
export function publishStyleChange(change: StyleChange): void {
  postJson(mcpPort(), "/style-change", JSON.stringify(change));
}

function postJson(
  port: number,
  urlPath: string,
  body: string,
  onResponse?: (status: number | undefined, data: string) => void,
  onError?: (err: Error) => void,
): void {
  const req = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 2000,
    },
    (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => onResponse?.(res.statusCode, data));
    },
  );
  req.on("error", (err) => onError?.(err));
  req.write(body);
  req.end();
}
