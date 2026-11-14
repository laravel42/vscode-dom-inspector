import { createHttpApp } from "./http.js";
import { startBridge } from "./bridge-mode.js";
import { createMcpServer, startMcpTransport } from "./mcp.js";

const HTTP_PORT = parseInt(process.env.DOM_INSPECTOR_PORT ?? "3100", 10);

// 1. HTTP bridge the editor extension posts picks to. If another DOM Inspector
//    MCP instance (started by a different AI client) already owns the port,
//    this one reads the selection from it instead.
void startBridge(createHttpApp(), HTTP_PORT);

// 2. MCP server on stdio, for any MCP client (Claude Code, Cursor, Kiro, Copilot, Cline, Windsurf…)
const mcpServer = createMcpServer();
startMcpTransport(mcpServer).catch((err) => {
  console.error("[mcp] Fatal:", err);
  process.exit(1);
});
