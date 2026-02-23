import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { SymbolDocSchema, type SymbolDoc } from "./schema.js";

export const CACHE_VERSION = "1";

export interface FileEntry {
  contentHash: string;
  symbols: SymbolDoc[];
}

export interface CacheManifest {
  cacheVersion: string;
  indexVersion: string;
  tsConfigHash: string;
  pluginNames: string[];
  files: Record<string, FileEntry>;
}

export interface DiffResult {
  changed: string[];
  deleted: string[];
  unchanged: string[];
}

export function toRelativePosixPath(
  filePath: string,
  projectRoot: string
): string {
  const rel = path.relative(projectRoot, filePath);
  return rel.split(path.sep).join("/");
}

export async function hashFileContents(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

const FileEntrySchema = z.object({
  contentHash: z.string(),
  symbols: z.array(SymbolDocSchema),
});

const CacheManifestSchema = z.object({
  cacheVersion: z.string(),
  indexVersion: z.string(),
  tsConfigHash: z.string(),
  pluginNames: z.array(z.string()),
  files: z.record(z.string(), FileEntrySchema),
});

export interface LoadCacheResult {
  manifest: CacheManifest;
  tsConfigHash: string;
}

export async function loadCache(opts: {
  cachePath: string;
  tsConfigFilePath: string;
  pluginNames: string[];
  indexVersion: string;
}): Promise<LoadCacheResult | null> {
  let raw: string;
  try {
    raw = await fs.readFile(opts.cachePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = CacheManifestSchema.safeParse(parsed);
  if (!result.success) return null;
  const manifest = result.data as CacheManifest;

  if (manifest.cacheVersion !== CACHE_VERSION) return null;
  if (manifest.indexVersion !== opts.indexVersion) return null;

  // Check tsconfig hash
  let currentTsConfigHash: string;
  try {
    currentTsConfigHash = await hashFileContents(opts.tsConfigFilePath);
  } catch {
    return null;
  }
  if (manifest.tsConfigHash !== currentTsConfigHash) return null;

  // Check plugin names
  const sortedPlugins = [...opts.pluginNames].sort();
  const cachedPlugins = manifest.pluginNames ?? [];
  if (
    sortedPlugins.length !== cachedPlugins.length ||
    sortedPlugins.some((name, i) => name !== cachedPlugins[i])
  ) {
    return null;
  }

  return { manifest, tsConfigHash: currentTsConfigHash };
}

export async function computeDiff(
  currentFiles: string[],
  projectRoot: string,
  cache: CacheManifest | null
): Promise<DiffResult> {
  const changed: string[] = [];
  const unchanged: string[] = [];

  const seenRelPaths = new Set<string>();

  for (const absPath of currentFiles) {
    const relPath = toRelativePosixPath(absPath, projectRoot);
    seenRelPaths.add(relPath);

    if (!cache) {
      changed.push(absPath);
      continue;
    }

    const cached = cache.files[relPath];
    if (!cached) {
      changed.push(absPath);
      continue;
    }

    const currentHash = await hashFileContents(absPath);
    if (currentHash !== cached.contentHash) {
      changed.push(absPath);
    } else {
      unchanged.push(absPath);
    }
  }

  const deleted: string[] = [];
  if (cache) {
    for (const relPath of Object.keys(cache.files)) {
      if (!seenRelPaths.has(relPath)) {
        deleted.push(relPath);
      }
    }
  }

  return { changed, deleted, unchanged };
}

export async function writeCache(
  cachePath: string,
  manifest: CacheManifest
): Promise<void> {
  const dir = path.dirname(cachePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(manifest, null, 2) + "\n");
}
