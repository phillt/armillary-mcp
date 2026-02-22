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

  const server = new McpServer({ name: "armillary-mcp", version: "1.0.0" });

  server.tool(
    "docs.list",
    "List all documented symbols (id, kind, name)",
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
    "Get full documentation for a symbol by its id",
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
    "Search symbols by name or description substring",
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
