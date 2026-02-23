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

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

export function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf-8")
    );
    if (typeof parsed.o === "number" && parsed.o >= 0) return parsed.o;
  } catch {
    /* invalid cursor */
  }
  return 0;
}

export interface ListSymbolsOptions {
  kind?: string;
  pathPrefix?: string;
  cursor?: string;
  limit?: number;
}

export interface ListSymbolsResult {
  symbols: Array<{ id: string; kind: string; name: string }>;
  nextCursor?: string;
  totalFiltered: number;
}

export function listSymbols(
  index: DocIndex,
  options: ListSymbolsOptions = {}
): ListSymbolsResult {
  const { kind, pathPrefix, cursor, limit: rawLimit } = options;
  const limit = Math.max(1, Math.min(rawLimit ?? 50, 200));

  const filtered = index.symbols.filter((s) => {
    if (kind && s.kind !== kind) return false;
    if (pathPrefix && !s.filePath.startsWith(pathPrefix)) return false;
    return true;
  });

  const offset = cursor ? decodeCursor(cursor) : 0;
  const page = filtered.slice(offset, offset + limit);

  const symbols = page.map((s) => ({ id: s.id, kind: s.kind, name: s.name }));
  const hasMore = offset + limit < filtered.length;

  return {
    symbols,
    totalFiltered: filtered.length,
    ...(hasMore ? { nextCursor: encodeCursor(offset + limit) } : {}),
  };
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
