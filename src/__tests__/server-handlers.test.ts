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
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-docs-server-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads a valid index file", async () => {
    const indexDir = path.join(tmpDir, ".mcp-docs");
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
      "Run `mcp-docs build` first"
    );
  });

  it("throws on invalid JSON", async () => {
    const indexDir = path.join(tmpDir, ".mcp-docs");
    await fs.mkdir(indexDir, { recursive: true });
    await fs.writeFile(path.join(indexDir, "index.json"), "not json{{{");

    await expect(loadDocIndex(tmpDir)).rejects.toThrow("Invalid JSON");
  });

  it("throws on schema mismatch", async () => {
    const indexDir = path.join(tmpDir, ".mcp-docs");
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

// -- listSymbols ------------------------------------------------------------

describe("listSymbols", () => {
  it("returns summary objects with id, kind, name", () => {
    const index = makeIndex([
      makeSymbol({ id: "a#foo", kind: "function", name: "foo" }),
      makeSymbol({ id: "b#Bar", kind: "class", name: "Bar" }),
    ]);

    const result = listSymbols(index);
    expect(result).toEqual([
      { id: "a#foo", kind: "function", name: "foo" },
      { id: "b#Bar", kind: "class", name: "Bar" },
    ]);
  });

  it("does not leak extra fields", () => {
    const result = listSymbols(makeIndex());
    expect(Object.keys(result[0])).toEqual(["id", "kind", "name"]);
  });

  it("returns empty array for empty index", () => {
    const result = listSymbols(makeIndex([]));
    expect(result).toEqual([]);
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
    const results = searchSymbols(index, "a", 2);
    expect(results).toHaveLength(2);
  });

  it("defaults to limit of 10", () => {
    // All 4 symbols match "a" somewhere in name or description
    const results = searchSymbols(index, "a");
    expect(results.length).toBeLessThanOrEqual(10);
  });

  it("clamps limit to max 100", () => {
    const results = searchSymbols(index, "a", 999);
    // Should not crash; just returns what's available
    expect(results.length).toBeLessThanOrEqual(100);
  });

  it("clamps limit to min 1", () => {
    const results = searchSymbols(index, "add", 0);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty array for no matches", () => {
    const results = searchSymbols(index, "zzzznotfound");
    expect(results).toEqual([]);
  });
});
