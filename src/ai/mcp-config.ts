import * as fs from "fs";
import * as path from "path";

/**
 * Registers the bundled DOM Inspector MCP server with MCP clients by writing
 * (or updating) each client's own config file. Pure helpers (`upsert*`,
 * `continueYaml`) do the text transformations; `applyMcpConfig` does the I/O.
 */

export const SERVER_NAME = "dom-inspector";

export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type McpClientId =
  | "kiro" | "cursor" | "vscode" | "claude-code" | "windsurf" | "roo-code" | "cline"
  | "continue" | "gemini-cli" | "codex-cli";

type Format = "mcpServers" | "vscode" | "continue-yaml" | "codex-toml";

export interface McpClient {
  id: McpClientId;
  label: string;
  scope: "workspace" | "global";
  format: Format;
  /** Extra fields some clients expect on the server entry. */
  extra?: Record<string, unknown>;
  file(paths: { workspace?: string; home: string; globalStorage: string }): string | null;
}

export const MCP_CLIENTS: McpClient[] = [
  { id: "kiro", label: "Kiro", scope: "workspace", format: "mcpServers", extra: { disabled: false, autoApprove: [] },
    file: (p) => p.workspace ? path.join(p.workspace, ".kiro", "settings", "mcp.json") : null },
  { id: "cursor", label: "Cursor", scope: "workspace", format: "mcpServers",
    file: (p) => p.workspace ? path.join(p.workspace, ".cursor", "mcp.json") : null },
  { id: "vscode", label: "VS Code (Copilot agent mode)", scope: "workspace", format: "vscode",
    file: (p) => p.workspace ? path.join(p.workspace, ".vscode", "mcp.json") : null },
  { id: "claude-code", label: "Claude Code (project .mcp.json)", scope: "workspace", format: "mcpServers",
    file: (p) => p.workspace ? path.join(p.workspace, ".mcp.json") : null },
  { id: "roo-code", label: "Roo Code (project)", scope: "workspace", format: "mcpServers",
    file: (p) => p.workspace ? path.join(p.workspace, ".roo", "mcp.json") : null },
  { id: "gemini-cli", label: "Gemini CLI (project)", scope: "workspace", format: "mcpServers",
    file: (p) => p.workspace ? path.join(p.workspace, ".gemini", "settings.json") : null },
  { id: "continue", label: "Continue (project)", scope: "workspace", format: "continue-yaml",
    file: (p) => p.workspace ? path.join(p.workspace, ".continue", "mcpServers", `${SERVER_NAME}.yaml`) : null },
  { id: "cline", label: "Cline (global)", scope: "global", format: "mcpServers", extra: { disabled: false, autoApprove: [] },
    // Cline keeps its MCP settings in its own global storage, a sibling of ours.
    file: (p) => path.join(path.dirname(p.globalStorage), "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json") },
  { id: "windsurf", label: "Windsurf (global)", scope: "global", format: "mcpServers",
    file: (p) => path.join(p.home, ".codeium", "windsurf", "mcp_config.json") },
  { id: "codex-cli", label: "Codex CLI (global)", scope: "global", format: "codex-toml",
    file: (p) => path.join(p.home, ".codex", "config.toml") },
];

/** The editor's own MCP client, configured automatically on activation. */
export function hostMcpClient(appName: string): McpClientId | null {
  if (/\bkiro\b/i.test(appName)) return "kiro";
  if (/\bcursor\b/i.test(appName)) return "cursor";
  if (/visual studio code|vscodium|code - oss/i.test(appName)) return "vscode";
  return null;
}

export interface UpsertResult { text: string; changed: boolean }

/**
 * Add or update our server inside a JSON config under `key` ("mcpServers" or
 * VS Code's "servers"). Existing entries keep user-added fields (env tweaks,
 * autoApprove…); only command/args (and type) are refreshed. Throws on
 * unparsable input (e.g. JSONC with comments) so we never clobber a file.
 */
export function upsertJsonConfig(
  existing: string | null,
  key: "mcpServers" | "servers",
  spec: McpServerSpec,
  extra: Record<string, unknown> = {},
): UpsertResult {
  const config: Record<string, unknown> = existing && existing.trim() ? JSON.parse(existing) : {};
  if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error("config root is not an object");
  const servers = (config[key] && typeof config[key] === "object" ? config[key] : {}) as Record<string, Record<string, unknown>>;
  const before = JSON.stringify(servers[SERVER_NAME] ?? null);
  const current = servers[SERVER_NAME];
  const base = key === "servers" ? { type: "stdio" } : {};
  servers[SERVER_NAME] = current
    ? { ...current, ...base, command: spec.command, args: spec.args }
    : { ...base, command: spec.command, args: spec.args, env: spec.env, ...extra };
  config[key] = servers;
  const changed = before !== JSON.stringify(servers[SERVER_NAME]);
  return { text: JSON.stringify(config, null, 2) + "\n", changed };
}

/** Continue reads one YAML block per file from .continue/mcpServers/. */
export function continueYaml(spec: McpServerSpec): string {
  const q = (s: string) => JSON.stringify(s); // JSON strings are valid YAML scalars
  return [
    "name: DOM Inspector",
    "version: 0.0.1",
    "schema: v1",
    "mcpServers:",
    `  - name: ${SERVER_NAME}`,
    `    command: ${q(spec.command)}`,
    `    args: [${spec.args.map(q).join(", ")}]`,
    "    env:",
    ...Object.entries(spec.env).map(([k, v]) => `      ${k}: ${q(v)}`),
    "",
  ].join("\n");
}

/** Add or replace the [mcp_servers.dom-inspector] table in Codex's config.toml. */
export function upsertCodexToml(existing: string | null, spec: McpServerSpec): UpsertResult {
  const q = (s: string) => JSON.stringify(s); // TOML basic strings use the same escapes
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${q(spec.command)}`,
    `args = [${spec.args.map(q).join(", ")}]`,
    `env = { ${Object.entries(spec.env).map(([k, v]) => `${k} = ${q(v)}`).join(", ")} }`,
  ].join("\n");
  const text = existing ?? "";
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === `[mcp_servers.${SERVER_NAME}]`);
  if (start === -1) {
    const sep = text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return { text: text + sep + block + "\n", changed: true };
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  // keep a blank line before the next table, if there was one
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  const out = [...lines.slice(0, start), ...block.split("\n"), ...lines.slice(end)].join("\n");
  return { text: out, changed: out !== text };
}

export interface ApplyResult { client: McpClientId; file: string | null; status: "created" | "updated" | "unchanged" | "skipped" | "error"; message?: string }

/** Write our server into one client's config. */
export function applyMcpConfig(
  client: McpClient,
  spec: McpServerSpec,
  paths: { workspace?: string; home: string; globalStorage: string },
): ApplyResult {
  const file = client.file(paths);
  if (!file) return { client: client.id, file: null, status: "skipped", message: "needs an open workspace folder" };
  try {
    const exists = fs.existsSync(file);
    const existing = exists ? fs.readFileSync(file, "utf-8") : null;
    let next: UpsertResult;
    switch (client.format) {
      case "mcpServers": next = upsertJsonConfig(existing, "mcpServers", spec, client.extra); break;
      case "vscode": next = upsertJsonConfig(existing, "servers", spec, client.extra); break;
      case "continue-yaml": { const t = continueYaml(spec); next = { text: t, changed: t !== existing }; break; }
      case "codex-toml": next = upsertCodexToml(existing, spec); break;
    }
    if (!next.changed) return { client: client.id, file, status: "unchanged" };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next.text);
    return { client: client.id, file, status: exists ? "updated" : "created" };
  } catch (err) {
    return { client: client.id, file, status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
