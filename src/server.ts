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
    "List indexed symbols with optional filtering and pagination. Use `kind` to filter by symbol type. Use `pathPrefix` to scope to a directory (e.g. \"src/utils/\"). Returns up to `limit` results per page (default 50). Pass the returned `nextCursor` as `cursor` to fetch the next page.",
    {
      kind: z
        .enum([
          "function",
          "class",
          "type",
          "const",
          "interface",
          "enum",
          "component",
        ])
        .optional(),
      pathPrefix: z.string().optional(),
      cursor: z.string().optional(),
      limit: z.number().optional(),
    },
    { annotations: toolAnnotations },
    ({ kind, pathPrefix, cursor, limit }, _extra) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            listSymbols(index, { kind, pathPrefix, cursor, limit }),
            null,
            2
          ),
        },
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
    "Search the armillary-mcp index for symbols matching a name or description substring. Returns matching functions, types, classes, and other exports. Use `kind` to narrow results to a specific symbol type.",
    {
      q: z.string(),
      kind: z
        .enum([
          "function",
          "class",
          "type",
          "const",
          "interface",
          "enum",
          "component",
        ])
        .optional(),
      limit: z.number().optional(),
    },
    { annotations: toolAnnotations },
    ({ q, kind, limit }, _extra) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            searchSymbols(index, q, { kind, limit }),
            null,
            2
          ),
        },
      ],
    })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
