import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import { extractJsDoc } from "../jsdoc.js";

function createProject() {
  return new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });
}

describe("extractJsDoc", () => {
  it("extracts description from a function", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `
/** Adds two numbers together */
export function add(a: number, b: number): number {
  return a + b;
}
`
    );
    const fn = sf.getFunctionOrThrow("add");
    const result = extractJsDoc(fn);
    expect(result).toEqual({ description: "Adds two numbers together" });
  });

  it("extracts @param tags", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `
/**
 * Adds two numbers.
 * @param a - The first number
 * @param b - The second number
 */
export function add(a: number, b: number): number {
  return a + b;
}
`
    );
    const fn = sf.getFunctionOrThrow("add");
    const result = extractJsDoc(fn);
    expect(result?.description).toBe("Adds two numbers.");
    expect(result?.params).toEqual([
      { name: "a", description: "The first number" },
      { name: "b", description: "The second number" },
    ]);
  });

  it("extracts @param tags with types", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `
/**
 * @param {string} name - The name
 */
export function greet(name: string): string {
  return name;
}
`
    );
    const fn = sf.getFunctionOrThrow("greet");
    const result = extractJsDoc(fn);
    expect(result?.params).toEqual([
      { name: "name", type: "string", description: "The name" },
    ]);
  });

  it("extracts @returns tag", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `
/**
 * Gets the sum.
 * @returns {number} The sum
 */
export function sum(): number {
  return 0;
}
`
    );
    const fn = sf.getFunctionOrThrow("sum");
    const result = extractJsDoc(fn);
    expect(result?.returns).toEqual({ type: "number", description: "The sum" });
  });

  it("extracts @return tag (alias)", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `
/**
 * @return The value
 */
export function getValue(): number {
  return 0;
}
`
    );
    const fn = sf.getFunctionOrThrow("getValue");
    const result = extractJsDoc(fn);
    expect(result?.returns).toEqual({ description: "The value" });
  });

  it("collects other tags into sorted record", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `
/**
 * A function.
 * @deprecated Use newFn instead
 * @since 1.0.0
 * @example doSomething()
 */
export function doSomething() {}
`
    );
    const fn = sf.getFunctionOrThrow("doSomething");
    const result = extractJsDoc(fn);
    expect(result?.tags).toEqual({
      deprecated: "Use newFn instead",
      example: "doSomething()",
      since: "1.0.0",
    });
    // Verify keys are sorted
    expect(Object.keys(result!.tags!)).toEqual(["deprecated", "example", "since"]);
  });

  it("concatenates duplicate tag names with newline", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `
/**
 * @example first()
 * @example second()
 */
export function multi() {}
`
    );
    const fn = sf.getFunctionOrThrow("multi");
    const result = extractJsDoc(fn);
    expect(result?.tags?.example).toBe("first()\nsecond()");
  });

  it("uses the last JSDoc comment on the node", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `
/** Old description */
/** New description */
export function fn() {}
`
    );
    const fn = sf.getFunctionOrThrow("fn");
    const result = extractJsDoc(fn);
    expect(result?.description).toBe("New description");
  });

  it("handles VariableDeclaration by walking up to VariableStatement", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `
/** A greeting function */
export const greet = (name: string) => \`Hello \${name}\`;
`
    );
    const varDecl = sf.getVariableDeclarationOrThrow("greet");
    const result = extractJsDoc(varDecl);
    expect(result?.description).toBe("A greeting function");
  });

  it("returns undefined for nodes without JSDoc", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `export function noDoc() {}`
    );
    const fn = sf.getFunctionOrThrow("noDoc");
    const result = extractJsDoc(fn);
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty JSDoc", () => {
    const project = createProject();
    const sf = project.createSourceFile(
      "test.ts",
      `
/** */
export function empty() {}
`
    );
    const fn = sf.getFunctionOrThrow("empty");
    const result = extractJsDoc(fn);
    expect(result).toBeUndefined();
  });
});
