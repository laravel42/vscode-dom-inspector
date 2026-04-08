import { createHttpServer } from "./http.js";
import { createMcpServer, startMcpTransport } from "./mcp.js";
const HTTP_PORT = parseInt(process.env.DOM_INSPECTOR_PORT ?? "3100", 10);
// 1. Start the HTTP bridge — always start our own so state is in-process.
//    If the port is taken, createHttpServer auto-increments and writes the port file.
createHttpServer(HTTP_PORT);
// 2. Start the MCP server on stdio for Kiro
const mcpServer = createMcpServer();
startMcpTransport(mcpServer).catch((err) => {
    console.error("[mcp] Fatal:", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map