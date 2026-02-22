import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  loadDocIndex,
  listSymbols,
  getSymbol,
  searchSymbols,
} from "./server-handlers.js";

const toolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

async function main() {
  let index;
  try {
    index = await loadDocIndex(process.cwd());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`armillary-mcp-server: ${message}\n`);
    process.exit(1);
  }

  const server = new McpServer({
    name: "armillary-mcp",
    version: "1.0.0",
    instructions:
      "Armillary MCP indexes TypeScript projects so you can discover and reuse existing code. Before writing new functions, utilities, or types, search the index to check if a suitable implementation already exists. Use docs.list to browse all indexed symbols, docs.search to find symbols by name or description, and docs.get to retrieve full documentation including signatures, parameters, and JSDoc annotations.",
  });

  server.tool(
    "docs.list",
    "List all symbols indexed by armillary-mcp (id, kind, name). Use this to browse the full set of exported functions, classes, types, interfaces, enums, and constants.",
    {},
    { annotations: toolAnnotations },
    (_extra) => ({
      content: [
        { type: "text", text: JSON.stringify(listSymbols(index), null, 2) },
      ],
    })
  );

  server.tool(
    "docs.get",
    "Get full documentation for an indexed symbol by its id, including signature, parameters, return type, and JSDoc annotations.",
    { id: z.string() },
    { annotations: toolAnnotations },
    ({ id }, _extra) => {
      const symbol = getSymbol(index, id);
      if (!symbol) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Symbol not found: ${id}` },
          ],
        };
      }
      return {
        content: [
          { type: "text", text: JSON.stringify(symbol, null, 2) },
        ],
      };
    }
  );

  server.tool(
    "docs.search",
    "Search the armillary-mcp index for symbols matching a name or description substring. Returns matching functions, types, classes, and other exports.",
    { q: z.string(), limit: z.number().optional() },
    { annotations: toolAnnotations },
    ({ q, limit }, _extra) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(searchSymbols(index, q, limit), null, 2),
        },
      ],
    })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
