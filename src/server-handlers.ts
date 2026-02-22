import fs from "node:fs/promises";
import path from "node:path";
import { DocIndexSchema, type DocIndex, type SymbolDoc } from "./schema.js";

export async function loadDocIndex(projectRoot: string): Promise<DocIndex> {
  const indexPath = path.join(projectRoot, ".armillary-mcp-docs", "index.json");

  let raw: string;
  try {
    raw = await fs.readFile(indexPath, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new Error(
        `Index file not found at ${indexPath}. Run \`armillary-mcp build\` first.`
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${indexPath}`);
  }

  const result = DocIndexSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Schema validation failed for ${indexPath}: ${result.error.message}`
    );
  }

  return result.data;
}

export function listSymbols(
  index: DocIndex
): Array<{ id: string; kind: string; name: string }> {
  return index.symbols.map((s) => ({ id: s.id, kind: s.kind, name: s.name }));
}

export function getSymbol(
  index: DocIndex,
  id: string
): SymbolDoc | undefined {
  return index.symbols.find((s) => s.id === id);
}

export function searchSymbols(
  index: DocIndex,
  query: string,
  limit?: number
): SymbolDoc[] {
  const effectiveLimit = Math.max(1, Math.min(limit ?? 10, 100));
  const lowerQuery = query.toLowerCase();
  const results: SymbolDoc[] = [];

  for (const symbol of index.symbols) {
    if (results.length >= effectiveLimit) break;

    const nameMatch = symbol.name.toLowerCase().includes(lowerQuery);
    const descMatch = symbol.description
      ?.toLowerCase()
      .includes(lowerQuery);

    if (nameMatch || descMatch) {
      results.push(symbol);
    }
  }

  return results;
}
