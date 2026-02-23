import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { generateDocIndex } from "../indexer.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "armillary-mcp-test-"));

  // Write a tsconfig.json
  await fs.writeFile(
    path.join(tmpDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        declaration: true,
        strict: true,
        skipLibCheck: true,
      },
      include: ["src"],
    })
  );

  // Create src directory
  await fs.mkdir(path.join(tmpDir, "src"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("generateDocIndex", () => {
  it("generates a valid doc index from a fixture project", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "math.ts"),
      `
/**
 * Adds two numbers.
 * @param a - First number
 * @param b - Second number
 * @returns The sum
 */
export function add(a: number, b: number): number {
  return a + b;
}

export interface MathOptions {
  precision: number;
}

export type NumberPair = [number, number];
`
    );

    const index = await generateDocIndex({
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
    });

    expect(index.version).toBe("1.0.0");
    expect(index.generatedAt).toBeTruthy();
    expect(index.projectRoot).toBe(tmpDir);
    expect(index.symbols).toHaveLength(3);

    const addSymbol = index.symbols.find((s) => s.name === "add");
    expect(addSymbol).toMatchObject({
      id: "src/math.ts#add",
      kind: "function",
      name: "add",
      filePath: "src/math.ts",
      exported: true,
      description: "Adds two numbers.",
    });
    expect(addSymbol?.params).toEqual([
      { name: "a", type: "number", description: "First number" },
      { name: "b", type: "number", description: "Second number" },
    ]);
    expect(addSymbol?.returns).toEqual({ description: "The sum" });

    const mathOptions = index.symbols.find((s) => s.name === "MathOptions");
    expect(mathOptions?.kind).toBe("interface");

    const numberPair = index.symbols.find((s) => s.name === "NumberPair");
    expect(numberPair?.kind).toBe("type");
  });

  it("writes output to .armillary-mcp-docs/index.json by default", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "simple.ts"),
      `export const VALUE = 42;`
    );

    await generateDocIndex({
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
    });

    const outputPath = path.join(tmpDir, ".armillary-mcp-docs", "index.json");
    const content = await fs.readFile(outputPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.symbols).toHaveLength(1);
  });

  it("writes output to custom path when specified", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "simple.ts"),
      `export const VALUE = 42;`
    );

    const customOutput = path.join(tmpDir, "custom", "output.json");
    await generateDocIndex({
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
      outputPath: customOutput,
    });

    const content = await fs.readFile(customOutput, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.symbols).toHaveLength(1);
  });

  it("excludes .d.ts files", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "types.d.ts"),
      `export declare function hidden(): void;`
    );
    await fs.writeFile(
      path.join(tmpDir, "src", "main.ts"),
      `export function visible() {}`
    );

    const index = await generateDocIndex({
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
    });

    const names = index.symbols.map((s) => s.name);
    expect(names).toContain("visible");
    expect(names).not.toContain("hidden");
  });

  it("produces deterministic output across runs (except generatedAt)", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "a.ts"),
      `export function alpha() {}\nexport function beta() {}`
    );
    await fs.writeFile(
      path.join(tmpDir, "src", "b.ts"),
      `export const gamma = 1;`
    );

    const opts = {
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
    };

    const index1 = await generateDocIndex(opts);
    const index2 = await generateDocIndex(opts);

    // Everything except generatedAt should match
    const strip = (idx: typeof index1) => ({ ...idx, generatedAt: "" });
    expect(strip(index1)).toEqual(strip(index2));
  });

  it("sorts symbols by file path and name", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "z.ts"),
      `export function zeta() {}`
    );
    await fs.writeFile(
      path.join(tmpDir, "src", "a.ts"),
      `export function beta() {}\nexport function alpha() {}`
    );

    const index = await generateDocIndex({
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
    });

    const names = index.symbols.map((s) => s.name);
    // a.ts comes before z.ts, and within a.ts alpha comes before beta
    expect(names).toEqual(["alpha", "beta", "zeta"]);
  });

  it("calls onProgress with monotonically increasing indexing events", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "a.ts"),
      `export function alpha() {}`
    );
    await fs.writeFile(
      path.join(tmpDir, "src", "b.ts"),
      `export function beta() {}`
    );

    const onProgress = vi.fn();

    await generateDocIndex({
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
      onProgress,
    });

    expect(onProgress).toHaveBeenCalled();

    const calls = onProgress.mock.calls.map((c) => c[0]);
    const indexingCalls = calls.filter((c) => c.phase === "indexing");

    expect(indexingCalls.length).toBe(2);

    // current increases monotonically from 1..N
    const currents = indexingCalls.map((c) => c.current);
    expect(currents).toEqual([1, 2]);

    // total is consistent across all calls
    const totals = new Set(indexingCalls.map((c) => c.total));
    expect(totals.size).toBe(1);
    expect(totals.has(2)).toBe(true);

    // last call's current equals total
    expect(indexingCalls[indexingCalls.length - 1].current).toBe(
      indexingCalls[indexingCalls.length - 1].total
    );

    // each call includes a file string
    for (const call of indexingCalls) {
      expect(typeof call.file).toBe("string");
      expect(call.file.length).toBeGreaterThan(0);
    }
  });

  it("calls onProgress with plugin phase events when plugins are used", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src", "main.ts"),
      `export function hello() {}`
    );
    await fs.writeFile(
      path.join(tmpDir, "src", "Widget.custom"),
      "<custom>content</custom>"
    );
    await fs.writeFile(
      path.join(tmpDir, "src", "Other.custom"),
      "<custom>other</custom>"
    );

    // Update tsconfig to include src directory
    await fs.writeFile(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
        },
        include: ["src"],
      })
    );

    const plugin = {
      name: "custom-plugin",
      extensions: [".custom"],
      extractSymbols: (filePath: string) => {
        const name = path.basename(filePath, ".custom");
        return [
          {
            id: `${name}.custom#default`,
            kind: "component" as const,
            name,
            filePath: `${name}.custom`,
            exported: true,
          },
        ];
      },
    };

    const onProgress = vi.fn();

    await generateDocIndex({
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
      plugins: [plugin],
      onProgress,
    });

    const calls = onProgress.mock.calls.map((c) => c[0]);
    const indexingCalls = calls.filter((c) => c.phase === "indexing");
    const pluginCalls = calls.filter((c) => c.phase === "plugins");

    // Should have indexing calls for .ts files
    expect(indexingCalls.length).toBeGreaterThan(0);

    // Should have plugin calls for .custom files
    expect(pluginCalls.length).toBe(2);

    // Plugin calls have their own monotonic current/total sequence
    const pluginCurrents = pluginCalls.map((c) => c.current);
    expect(pluginCurrents).toEqual([1, 2]);

    const pluginTotals = new Set(pluginCalls.map((c) => c.total));
    expect(pluginTotals.size).toBe(1);
    expect(pluginTotals.has(2)).toBe(true);

    // Each plugin call includes a file string
    for (const call of pluginCalls) {
      expect(typeof call.file).toBe("string");
      expect(call.file.length).toBeGreaterThan(0);
    }
  });
});
