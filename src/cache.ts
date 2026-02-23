import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SymbolDoc } from "./schema.js";

export const CACHE_VERSION = "1";

export interface FileEntry {
  contentHash: string;
  symbols: SymbolDoc[];
  mtimeMs?: number;
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
  /** Maps absolute file path → content hash for every file that was hashed during diff. */
  hashes: Map<string, string>;
  /** Maps absolute file path → current mtimeMs for files that were stat'd or hashed. */
  mtimes: Map<string, number>;
}

export function toRelativePosixPath(
  filePath: string,
  projectRoot: string
): string {
  const rel = path.relative(projectRoot, filePath);
  if (path.sep === "/") return rel;
  return rel.replaceAll(path.sep, "/");
}

export async function hashFileContents(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Lightweight envelope check — validates top-level field types only.
 * File entries and symbols are trusted (written by our own indexer code).
 */
function isValidCacheEnvelope(value: unknown): value is CacheManifest {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.cacheVersion === "string" &&
    typeof obj.indexVersion === "string" &&
    typeof obj.tsConfigHash === "string" &&
    Array.isArray(obj.pluginNames) &&
    typeof obj.files === "object" &&
    obj.files !== null &&
    !Array.isArray(obj.files)
  );
}

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

  if (!isValidCacheEnvelope(parsed)) return null;
  const manifest = parsed;

  // Cheap string comparisons first — avoid I/O if these fail
  if (manifest.cacheVersion !== CACHE_VERSION) return null;
  if (manifest.indexVersion !== opts.indexVersion) return null;

  // Check plugin names (still cheap — in-memory comparison)
  const sortedPlugins = [...opts.pluginNames].sort();
  const cachedPlugins = manifest.pluginNames ?? [];
  if (
    sortedPlugins.length !== cachedPlugins.length ||
    sortedPlugins.some((name, i) => name !== cachedPlugins[i])
  ) {
    return null;
  }

  // Check tsconfig hash (expensive — requires file I/O + hashing)
  let currentTsConfigHash: string;
  try {
    currentTsConfigHash = await hashFileContents(opts.tsConfigFilePath);
  } catch {
    return null;
  }
  if (manifest.tsConfigHash !== currentTsConfigHash) return null;

  return { manifest, tsConfigHash: currentTsConfigHash };
}

export async function computeDiff(
  currentFiles: string[],
  projectRoot: string,
  cache: CacheManifest | null
): Promise<DiffResult> {
  const changed: string[] = [];
  const unchanged: string[] = [];
  const hashes = new Map<string, string>();
  const mtimes = new Map<string, number>();

  const seenRelPaths = new Set<string>();

  if (!cache) {
    // No cache — all files are changed, no hashing needed
    for (const absPath of currentFiles) {
      seenRelPaths.add(toRelativePosixPath(absPath, projectRoot));
      changed.push(absPath);
    }
    return { changed, deleted: [], unchanged, hashes, mtimes };
  }

  // Separate files that need checking from definitely-new files
  const needsCheck: { absPath: string; cached: FileEntry }[] = [];

  for (const absPath of currentFiles) {
    const relPath = toRelativePosixPath(absPath, projectRoot);
    seenRelPaths.add(relPath);

    const cached = cache.files[relPath];
    if (!cached) {
      changed.push(absPath);
    } else {
      needsCheck.push({ absPath, cached });
    }
  }

  // Check in parallel batches to avoid EMFILE errors
  const BATCH_CONCURRENCY = 32;
  for (let i = 0; i < needsCheck.length; i += BATCH_CONCURRENCY) {
    const batch = needsCheck.slice(i, i + BATCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ({ absPath, cached }) => {
        // mtime fast path: if cached entry has mtimeMs and current stat matches, skip hashing
        const stat = await fs.stat(absPath);
        const currentMtime = stat.mtimeMs;
        if (cached.mtimeMs !== undefined && currentMtime === cached.mtimeMs) {
          return { absPath, match: true, hash: undefined as string | undefined, mtime: currentMtime };
        }
        // mtime differs or not available — fall back to content hash
        const currentHash = await hashFileContents(absPath);
        return { absPath, match: currentHash === cached.contentHash, hash: currentHash, mtime: currentMtime };
      })
    );
    for (const { absPath, match, hash, mtime } of results) {
      if (hash !== undefined) hashes.set(absPath, hash);
      mtimes.set(absPath, mtime);
      (match ? unchanged : changed).push(absPath);
    }
  }

  const deleted: string[] = [];
  for (const relPath of Object.keys(cache.files)) {
    if (!seenRelPaths.has(relPath)) {
      deleted.push(relPath);
    }
  }

  return { changed, deleted, unchanged, hashes, mtimes };
}

export async function writeCache(
  cachePath: string,
  manifest: CacheManifest
): Promise<void> {
  const dir = path.dirname(cachePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(manifest));
}
