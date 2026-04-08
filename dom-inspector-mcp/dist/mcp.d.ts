import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export declare function createMcpServer(): McpServer;
export declare function startMcpTransport(server: McpServer): Promise<void>;
