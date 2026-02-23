import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { DocIndex, SymbolDoc } from "../schema.js";
import {
  loadDocIndex,
  listSymbols,
  getSymbol,
  searchSymbols,
  encodeCursor,
  decodeCursor,
} from "../server-handlers.js";

// -- fixtures ---------------------------------------------------------------

function makeSymbol(overrides: Partial<SymbolDoc> = {}): SymbolDoc {
  return {
    id: "src/math.ts#add",
    kind: "function",
    name: "add",
    filePath: "src/math.ts",
    exported: true,
    signature: "(a: number, b: number) => number",
    description: "Adds two numbers together",
    ...overrides,
  };
}

function makeIndex(symbols: SymbolDoc[] = [makeSymbol()]): DocIndex {
  return {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    projectRoot: "/tmp/test",
    symbols,
  };
}

// -- loadDocIndex -----------------------------------------------------------

describe("loadDocIndex", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "armillary-mcp-server-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads a valid index file", async () => {
    const indexDir = path.join(tmpDir, ".armillary-mcp-docs");
    await fs.mkdir(indexDir, { recursive: true });
    await fs.writeFile(
      path.join(indexDir, "index.json"),
      JSON.stringify(makeIndex())
    );

    const index = await loadDocIndex(tmpDir);
    expect(index.version).toBe("1.0.0");
    expect(index.symbols).toHaveLength(1);
    expect(index.symbols[0].name).toBe("add");
  });

  it("throws with helpful message when file is missing", async () => {
    await expect(loadDocIndex(tmpDir)).rejects.toThrow(
      "Run `armillary-mcp build` first"
    );
  });

  it("throws on invalid JSON", async () => {
    const indexDir = path.join(tmpDir, ".armillary-mcp-docs");
    await fs.mkdir(indexDir, { recursive: true });
    await fs.writeFile(path.join(indexDir, "index.json"), "not json{{{");

    await expect(loadDocIndex(tmpDir)).rejects.toThrow("Invalid JSON");
  });

  it("throws on schema mismatch", async () => {
    const indexDir = path.join(tmpDir, ".armillary-mcp-docs");
    await fs.mkdir(indexDir, { recursive: true });
    await fs.writeFile(
      path.join(indexDir, "index.json"),
      JSON.stringify({ wrong: "shape" })
    );

    await expect(loadDocIndex(tmpDir)).rejects.toThrow(
      "Schema validation failed"
    );
  });
});

// -- encodeCursor / decodeCursor --------------------------------------------

describe("encodeCursor / decodeCursor", () => {
  it("round-trips correctly", () => {
    expect(decodeCursor(encodeCursor(0))).toBe(0);
    expect(decodeCursor(encodeCursor(50))).toBe(50);
    expect(decodeCursor(encodeCursor(200))).toBe(200);
  });

  it("returns 0 for invalid cursor", () => {
    expect(decodeCursor("not-valid-base64url")).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(decodeCursor("")).toBe(0);
  });

  it("returns 0 for negative offset in cursor", () => {
    const bad = Buffer.from(JSON.stringify({ o: -5 })).toString("base64url");
    expect(decodeCursor(bad)).toBe(0);
  });

  it("returns 0 for fractional offset in cursor", () => {
    const bad = Buffer.from(JSON.stringify({ o: 2.5 })).toString("base64url");
    expect(decodeCursor(bad)).toBe(0);
  });
});

// -- listSymbols ------------------------------------------------------------

describe("listSymbols", () => {
  it("returns summary objects with id, kind, name", () => {
    const index = makeIndex([
      makeSymbol({ id: "a#foo", kind: "function", name: "foo" }),
      makeSymbol({ id: "b#Bar", kind: "class", name: "Bar" }),
    ]);

    const result = listSymbols(index);
    expect(result.symbols).toEqual([
      { id: "a#foo", kind: "function", name: "foo" },
      { id: "b#Bar", kind: "class", name: "Bar" },
    ]);
    expect(result.totalFiltered).toBe(2);
  });

  it("does not leak extra fields", () => {
    const result = listSymbols(makeIndex());
    expect(Object.keys(result.symbols[0])).toEqual(["id", "kind", "name"]);
  });

  it("returns empty array for empty index", () => {
    const result = listSymbols(makeIndex([]));
    expect(result.symbols).toEqual([]);
    expect(result.totalFiltered).toBe(0);
  });

  it("filters by kind", () => {
    const index = makeIndex([
      makeSymbol({ id: "a#foo", kind: "function", name: "foo" }),
      makeSymbol({ id: "b#Bar", kind: "class", name: "Bar" }),
      makeSymbol({ id: "c#baz", kind: "function", name: "baz" }),
    ]);

    const result = listSymbols(index, { kind: "function" });
    expect(result.symbols).toEqual([
      { id: "a#foo", kind: "function", name: "foo" },
      { id: "c#baz", kind: "function", name: "baz" },
    ]);
    expect(result.totalFiltered).toBe(2);
  });

  it("returns empty when kind matches nothing", () => {
    const index = makeIndex([
      makeSymbol({ id: "a#foo", kind: "function", name: "foo" }),
    ]);

    const result = listSymbols(index, { kind: "class" });
    expect(result.symbols).toEqual([]);
    expect(result.totalFiltered).toBe(0);
  });

  it("filters by pathPrefix", () => {
    const index = makeIndex([
      makeSymbol({ id: "a#foo", name: "foo", filePath: "src/utils/math.ts" }),
      makeSymbol({ id: "b#bar", name: "bar", filePath: "src/core/app.ts" }),
      makeSymbol({ id: "c#baz", name: "baz", filePath: "src/utils/string.ts" }),
    ]);

    const result = listSymbols(index, { pathPrefix: "src/utils/" });
    expect(result.symbols.map((s) => s.name)).toEqual(["foo", "baz"]);
    expect(result.totalFiltered).toBe(2);
  });

  it("combines kind + pathPrefix", () => {
    const index = makeIndex([
      makeSymbol({ id: "a#foo", kind: "function", name: "foo", filePath: "src/utils/math.ts" }),
      makeSymbol({ id: "b#Bar", kind: "class", name: "Bar", filePath: "src/utils/math.ts" }),
      makeSymbol({ id: "c#baz", kind: "function", name: "baz", filePath: "src/core/app.ts" }),
    ]);

    const result = listSymbols(index, { kind: "function", pathPrefix: "src/utils/" });
    expect(result.symbols).toEqual([
      { id: "a#foo", kind: "function", name: "foo" },
    ]);
    expect(result.totalFiltered).toBe(1);
  });

  it("paginates with default limit of 50", () => {
    const symbols = Array.from({ length: 75 }, (_, i) =>
      makeSymbol({ id: `s#sym${i}`, name: `sym${i}` })
    );
    const index = makeIndex(symbols);

    const page1 = listSymbols(index);
    expect(page1.symbols).toHaveLength(50);
    expect(page1.totalFiltered).toBe(75);
    expect(page1.nextCursor).toBeDefined();
  });

  it("returns page 2 via cursor", () => {
    const symbols = Array.from({ length: 75 }, (_, i) =>
      makeSymbol({ id: `s#sym${i}`, name: `sym${i}` })
    );
    const index = makeIndex(symbols);

    const page1 = listSymbols(index);
    const page2 = listSymbols(index, { cursor: page1.nextCursor });
    expect(page2.symbols).toHaveLength(25);
    expect(page2.totalFiltered).toBe(75);
    expect(page2.nextCursor).toBeUndefined();
  });

  it("respects custom limit", () => {
    const symbols = Array.from({ length: 20 }, (_, i) =>
      makeSymbol({ id: `s#sym${i}`, name: `sym${i}` })
    );
    const index = makeIndex(symbols);

    const result = listSymbols(index, { limit: 5 });
    expect(result.symbols).toHaveLength(5);
    expect(result.nextCursor).toBeDefined();
  });

  it("clamps limit to max 200", () => {
    const symbols = Array.from({ length: 10 }, (_, i) =>
      makeSymbol({ id: `s#sym${i}`, name: `sym${i}` })
    );
    const index = makeIndex(symbols);

    const result = listSymbols(index, { limit: 999 });
    expect(result.symbols).toHaveLength(10);
  });

  it("clamps limit to min 1", () => {
    const index = makeIndex([
      makeSymbol({ id: "a#foo", name: "foo" }),
      makeSymbol({ id: "b#bar", name: "bar" }),
    ]);

    const result = listSymbols(index, { limit: 0 });
    expect(result.symbols).toHaveLength(1);
  });

  it("falls back to default limit when given NaN", () => {
    const symbols = Array.from({ length: 75 }, (_, i) =>
      makeSymbol({ id: `s#sym${i}`, name: `sym${i}` })
    );
    const index = makeIndex(symbols);

    const result = listSymbols(index, { limit: NaN });
    expect(result.symbols).toHaveLength(50);
  });

  it("truncates float limit to integer", () => {
    const symbols = Array.from({ length: 20 }, (_, i) =>
      makeSymbol({ id: `s#sym${i}`, name: `sym${i}` })
    );
    const index = makeIndex(symbols);

    const result = listSymbols(index, { limit: 5.9 });
    expect(result.symbols).toHaveLength(5);
  });

  it("invalid cursor gracefully returns first page", () => {
    const symbols = Array.from({ length: 10 }, (_, i) =>
      makeSymbol({ id: `s#sym${i}`, name: `sym${i}` })
    );
    const index = makeIndex(symbols);

    const result = listSymbols(index, { cursor: "garbage!!!" });
    expect(result.symbols).toHaveLength(10);
    expect(result.symbols[0].id).toBe("s#sym0");
  });

  it("pagination within filtered results", () => {
    const symbols = Array.from({ length: 30 }, (_, i) =>
      makeSymbol({
        id: `s#sym${i}`,
        name: `sym${i}`,
        kind: i % 2 === 0 ? "function" : "class",
      })
    );
    const index = makeIndex(symbols);

    const page1 = listSymbols(index, { kind: "function", limit: 5 });
    expect(page1.symbols).toHaveLength(5);
    expect(page1.totalFiltered).toBe(15);
    expect(page1.nextCursor).toBeDefined();
    expect(page1.symbols.every((s) => s.kind === "function")).toBe(true);

    const page2 = listSymbols(index, { kind: "function", limit: 5, cursor: page1.nextCursor });
    expect(page2.symbols).toHaveLength(5);
    expect(page2.symbols.every((s) => s.kind === "function")).toBe(true);
  });
});

// -- getSymbol --------------------------------------------------------------

describe("getSymbol", () => {
  it("returns the full symbol for a valid id", () => {
    const sym = makeSymbol({ id: "src/math.ts#add" });
    const index = makeIndex([sym]);

    const result = getSymbol(index, "src/math.ts#add");
    expect(result).toEqual(sym);
  });

  it("returns undefined for a missing id", () => {
    const result = getSymbol(makeIndex(), "nonexistent#id");
    expect(result).toBeUndefined();
  });
});

// -- searchSymbols ----------------------------------------------------------

describe("searchSymbols", () => {
  const symbols = [
    makeSymbol({ id: "a#add", name: "add", description: "Adds two numbers" }),
    makeSymbol({
      id: "b#subtract",
      name: "subtract",
      description: "Subtracts two numbers",
    }),
    makeSymbol({
      id: "c#multiply",
      name: "multiply",
      description: "Multiplies values",
    }),
    makeSymbol({
      id: "d#AddResult",
      name: "AddResult",
      kind: "type",
      description: "Result of addition",
    }),
  ];
  const index = makeIndex(symbols);

  it("matches by name (case-insensitive)", () => {
    const results = searchSymbols(index, "ADD");
    expect(results.map((s) => s.name)).toContain("add");
    expect(results.map((s) => s.name)).toContain("AddResult");
  });

  it("matches by description substring", () => {
    const results = searchSymbols(index, "multiplies");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("multiply");
  });

  it("respects limit parameter", () => {
    const results = searchSymbols(index, "a", { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("defaults to limit of 10", () => {
    const results = searchSymbols(index, "a");
    expect(results.length).toBeLessThanOrEqual(10);
  });

  it("clamps limit to max 100", () => {
    const results = searchSymbols(index, "a", { limit: 999 });
    expect(results.length).toBeLessThanOrEqual(100);
  });

  it("clamps limit to min 1", () => {
    const results = searchSymbols(index, "add", { limit: 0 });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty array for no matches", () => {
    const results = searchSymbols(index, "zzzznotfound");
    expect(results).toEqual([]);
  });

  it("filters by kind in combination with text query", () => {
    const results = searchSymbols(index, "add", { kind: "type" });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("AddResult");
  });

  it("kind alone without matching text returns nothing", () => {
    const results = searchSymbols(index, "zzzznotfound", { kind: "function" });
    expect(results).toEqual([]);
  });

  it("accepts a numeric limit for backward compatibility", () => {
    const results = searchSymbols(index, "add", 2);
    expect(results).toHaveLength(2);
  });
});
