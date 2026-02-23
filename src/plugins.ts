import fs from "node:fs/promises";
import path from "node:path";
import type { Project } from "ts-morph";
import type { SymbolDoc } from "./schema.js";
import { EXCLUDED_PATTERNS } from "./indexer.js";

export interface PluginContext {
  projectRoot: string;
  tsConfigFilePath: string;
  project?: Project;
}

export interface ArmillaryPlugin {
  name: string;
  extensions: string[]; // e.g., [".vue"]

  // Lifecycle
  init?(context: PluginContext): Promise<void> | void;
  dispose?(): Promise<void> | void;

  // Simple: return extracted TS code, core feeds it to ts-morph
  extract?(filePath: string, content: string): string | null;

  // Rich: return fully-formed symbols directly
  extractSymbols?(
    filePath: string,
    content: string
  ): Promise<SymbolDoc[]> | SymbolDoc[];
}

export async function loadPlugins(
  names: string[],
  projectRoot: string
): Promise<ArmillaryPlugin[]> {
  const plugins: ArmillaryPlugin[] = [];

  const resolvedRoot = path.resolve(projectRoot);

  for (const name of names) {
    let specifier: string;
    if (name.startsWith(".")) {
      const resolved = path.resolve(resolvedRoot, name);
      const normalized = path.normalize(resolved);
      const rootPrefix = resolvedRoot.endsWith(path.sep)
        ? resolvedRoot
        : resolvedRoot + path.sep;
      if (normalized !== resolvedRoot && !normalized.startsWith(rootPrefix)) {
        throw new Error(
          `Plugin "${name}" resolves outside the project root: ${normalized}`
        );
      }
      specifier = normalized;
    } else {
      specifier = name;
    }

    let mod: unknown;
    try {
      mod = await import(specifier);
    } catch (err) {
      throw new Error(
        `Failed to load plugin "${name}": ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const plugin = validatePlugin(mod, name);
    plugins.push(plugin);
  }

  return plugins;
}

function validatePlugin(mod: unknown, name: string): ArmillaryPlugin {
  // Handle default export or direct module
  const obj =
    mod != null && typeof mod === "object" && "default" in mod
      ? (mod as Record<string, unknown>).default
      : mod;

  if (obj == null || typeof obj !== "object") {
    throw new Error(`Plugin "${name}" does not export a valid object`);
  }

  const plugin = obj as Record<string, unknown>;

  if (typeof plugin.name !== "string" || plugin.name.length === 0) {
    throw new Error(`Plugin "${name}" must export a "name" string`);
  }

  if (
    !Array.isArray(plugin.extensions) ||
    plugin.extensions.length === 0 ||
    !plugin.extensions.every(
      (e: unknown) => typeof e === "string" && e.startsWith(".")
    )
  ) {
    throw new Error(
      `Plugin "${name}" must export an "extensions" array of dot-prefixed strings`
    );
  }

  const hasExtract = typeof plugin.extract === "function";
  const hasExtractSymbols = typeof plugin.extractSymbols === "function";

  if (!hasExtract && !hasExtractSymbols) {
    throw new Error(
      `Plugin "${name}" must implement either "extract" or "extractSymbols"`
    );
  }

  return obj as ArmillaryPlugin;
}

export async function findPluginFiles(
  projectRoot: string,
  extensions: string[],
  excludePatterns: RegExp[] = EXCLUDED_PATTERNS
): Promise<string[]> {
  const extSet = new Set(extensions.map((e) => e.toLowerCase()));
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (excludePatterns.some((p) => p.test(fullPath))) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extSet.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(projectRoot);
  return results.sort();
}

/**
 * Walk the directory tree once and bucket files by plugin index.
 * Returns an array parallel to `plugins` — each element is the sorted file list for that plugin.
 */
export async function findAllPluginFiles(
  projectRoot: string,
  plugins: ArmillaryPlugin[],
  excludePatterns: RegExp[] = EXCLUDED_PATTERNS
): Promise<string[][]> {
  // Build a map from lowercase extension → list of plugin indices that claim it
  const extToPluginIndices = new Map<string, number[]>();
  for (let i = 0; i < plugins.length; i++) {
    for (const ext of plugins[i].extensions) {
      const key = ext.toLowerCase();
      let indices = extToPluginIndices.get(key);
      if (!indices) {
        indices = [];
        extToPluginIndices.set(key, indices);
      }
      indices.push(i);
    }
  }

  // One result bucket per plugin
  const buckets: string[][] = plugins.map(() => []);

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (excludePatterns.some((p) => p.test(fullPath))) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const indices = extToPluginIndices.get(ext);
        if (indices) {
          for (const idx of indices) {
            buckets[idx].push(fullPath);
          }
        }
      }
    }
  }

  await walk(projectRoot);

  // Sort each bucket for determinism
  for (const bucket of buckets) {
    bucket.sort();
  }

  return buckets;
}
