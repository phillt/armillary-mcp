import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import { extractFileSymbols } from "../extractor.js";

function createProject() {
  return new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });
}

describe("extractFileSymbols", () => {
  it("extracts a simple exported function", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "/project/src/math.ts",
      `export function add(a: number, b: number): number {
  return a + b;
}`
    );
    const symbols = extractFileSymbols(sf, "/project");
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({
      id: "src/math.ts#add",
      kind: "function",
      name: "add",
      filePath: "src/math.ts",
      exported: true,
    });
    expect(symbols[0].params).toEqual([
      { name: "a", type: "number" },
      { name: "b", type: "number" },
    ]);
  });

  it("extracts exported interface", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "/project/src/types.ts",
      `export interface Config {
  name: string;
  value: number;
}`
    );
    const symbols = extractFileSymbols(sf, "/project");
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({
      id: "src/types.ts#Config",
      kind: "interface",
      name: "Config",
    });
  });

  it("extracts exported type alias", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "/project/src/types.ts",
      `export type ID = string | number;`
    );
    const symbols = extractFileSymbols(sf, "/project");
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({
      kind: "type",
      name: "ID",
    });
  });

  it("extracts exported enum", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "/project/src/enums.ts",
      `export enum Color { Red, Green, Blue }`
    );
    const symbols = extractFileSymbols(sf, "/project");
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({
      kind: "enum",
      name: "Color",
    });
  });

  it("classifies arrow function variables as 'function'", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "/project/src/utils.ts",
      `export const greet = (name: string): string => \`Hello \${name}\`;`
    );
    const symbols = extractFileSymbols(sf, "/project");
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({
      kind: "function",
      name: "greet",
    });
    expect(symbols[0].params).toEqual([
      { name: "name", type: "string" },
    ]);
  });

  it("classifies const variables as 'const'", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "/project/src/config.ts",
      `export const MAX_SIZE: number = 100;`
    );
    const symbols = extractFileSymbols(sf, "/project");
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({
      kind: "const",
      name: "MAX_SIZE",
    });
  });

  it("extracts exported class", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "/project/src/service.ts",
      `export class Service {
  run() { return true; }
}`
    );
    const symbols = extractFileSymbols(sf, "/project");
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({
      kind: "class",
      name: "Service",
    });
  });

  it("extracts all exports regardless of declaration order", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "/project/src/multi.ts",
      `
export function zebra() {}
export function alpha() {}
export function middle() {}
`
    );
    const symbols = extractFileSymbols(sf, "/project");
    const names = symbols.map((s) => s.name).sort();
    // All three exports are present (sorting is done globally by the indexer)
    expect(names).toEqual(["alpha", "middle", "zebra"]);
  });

  it("skips re-exports from other files", () => {
    const project = createProject();
    project.createSourceFile(
      "/project/src/original.ts",
      `export function helper() {}`
    );
    const barrel = project.createSourceFile(
      "/project/src/index.ts",
      `export { helper } from "./original.js";`
    );
    const symbols = extractFileSymbols(barrel, "/project");
    expect(symbols).toHaveLength(0);
  });

  it("merges AST params with JSDoc descriptions", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "/project/src/fn.ts",
      `
/**
 * Processes a value.
 * @param value - The value to process
 * @param options - Processing options
 */
export function process(value: string, options: Record<string, unknown>): void {}
`
    );
    const symbols = extractFileSymbols(sf, "/project");
    expect(symbols[0].params).toEqual([
      { name: "value", type: "string", description: "The value to process" },
      { name: "options", type: "Record<string, unknown>", description: "Processing options" },
    ]);
    expect(symbols[0].description).toBe("Processes a value.");
  });

  it("handles multiple exports from one file", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "/project/src/mixed.ts",
      `
export interface Config { name: string; }
export type ID = string;
export const VERSION = "1.0";
export function init() {}
`
    );
    const symbols = extractFileSymbols(sf, "/project");
    expect(symbols).toHaveLength(4);
    const kinds = symbols.map((s) => s.kind);
    expect(kinds).toContain("interface");
    expect(kinds).toContain("type");
    expect(kinds).toContain("const");
    expect(kinds).toContain("function");
  });
});
