import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getCurrentSelection } from "./state.js";
import {
  formatSelectionAsMarkdown,
  formatNoSelection,
  formatAnalysisPrompt,
  formatApplyStylesPrompt,
  formatRemoveNodePrompt,
  formatNoSelectionPrompt,
} from "./formatters.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "dom-inspector",
    version: "1.0.0",
  });

  // --- Resource: [DOM] Select node ---
  server.resource(
    "[DOM] Select node",
    "dom-inspector://selected-node",
    async (uri) => {
      const sel = getCurrentSelection();
      const text = sel
        ? formatSelectionAsMarkdown(sel)
        : formatNoSelection();

      return {
        contents: [{ uri: uri.href, text, mimeType: "text/markdown" }],
      };
    },
  );

  // --- Prompt: [DOM] Analyze node ---
  server.prompt(
    "[DOM] Analyze node",
    "Analyze the selected DOM element for accessibility, testability, and purpose",
    () => {
      const sel = getCurrentSelection();
      const text = sel ? formatAnalysisPrompt(sel) : formatNoSelectionPrompt();
      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
      };
    },
  );

  // --- Prompt: [DOM] Apply styles ---
  server.prompt(
    "[DOM] Apply styles",
    "Apply recorded style changes from the DOM Inspector to the source code",
    () => {
      const sel = getCurrentSelection();
      const text = sel ? formatApplyStylesPrompt(sel) : formatNoSelectionPrompt();
      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
      };
    },
  );

  // --- Prompt: [DOM] Remove node ---
  server.prompt(
    "[DOM] Remove node",
    "Remove the selected DOM element from the source code",
    () => {
      const sel = getCurrentSelection();
      const text = sel ? formatRemoveNodePrompt(sel) : formatNoSelectionPrompt();
      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
      };
    },
  );

  return server;
}

export async function startMcpTransport(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] DOM Inspector MCP server connected via stdio");
}
