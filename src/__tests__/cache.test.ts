import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  hashFileContents,
  loadCache,
  computeDiff,
  writeCache,
  toRelativePosixPath,
  CACHE_VERSION,
  type CacheManifest,
} from "../cache.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "armillary-cache-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("hashFileContents", () => {
  it("returns a consistent SHA-256 hex string", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "hello world");

    const hash1 = await hashFileContents(filePath);
    const hash2 = await hashFileContents(filePath);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns different hashes for different contents", async () => {
    const file1 = path.join(tmpDir, "a.txt");
    const file2 = path.join(tmpDir, "b.txt");
    await fs.writeFile(file1, "hello");
    await fs.writeFile(file2, "world");

    const hash1 = await hashFileContents(file1);
    const hash2 = await hashFileContents(file2);

    expect(hash1).not.toBe(hash2);
  });
});

describe("computeDiff", () => {
  it("with null cache, all files are changed and hashes map is empty", async () => {
    const file1 = path.join(tmpDir, "a.ts");
    const file2 = path.join(tmpDir, "b.ts");
    await fs.writeFile(file1, "export const a = 1;");
    await fs.writeFile(file2, "export const b = 2;");

    const diff = await computeDiff([file1, file2], tmpDir, null);

    expect(diff.changed).toEqual([file1, file2]);
    expect(diff.unchanged).toEqual([]);
    expect(diff.deleted).toEqual([]);
    // No cache means no hashing was performed
    expect(diff.hashes.size).toBe(0);
  });

  it("correctly classifies changed, unchanged, deleted, and new files", async () => {
    const unchangedFile = path.join(tmpDir, "unchanged.ts");
    const changedFile = path.join(tmpDir, "changed.ts");
    const newFile = path.join(tmpDir, "new.ts");
    await fs.writeFile(unchangedFile, "export const x = 1;");
    await fs.writeFile(changedFile, "export const y = 2;");
    await fs.writeFile(newFile, "export const z = 3;");

    const unchangedHash = await hashFileContents(unchangedFile);
    const oldChangedHash = await hashFileContents(changedFile);

    const cache: CacheManifest = {
      cacheVersion: CACHE_VERSION,
      indexVersion: "1.0.0",
      tsConfigHash: "abc",
      pluginNames: [],
      files: {
        "unchanged.ts": { contentHash: unchangedHash, symbols: [] },
        "changed.ts": { contentHash: oldChangedHash, symbols: [] },
        "deleted.ts": { contentHash: "deadbeef", symbols: [] },
      },
    };

    // Modify the changed file
    await fs.writeFile(changedFile, "export const y = 999;");

    const diff = await computeDiff(
      [unchangedFile, changedFile, newFile],
      tmpDir,
      cache
    );

    expect(diff.unchanged).toEqual([unchangedFile]);
    expect(diff.changed.sort()).toEqual([changedFile, newFile].sort());
    expect(diff.deleted).toEqual(["deleted.ts"]);

    // Hashes should contain entries for files that were hashed (cached files only)
    // New files (not in cache) are not hashed during diff
    expect(diff.hashes.has(unchangedFile)).toBe(true);
    expect(diff.hashes.has(changedFile)).toBe(true);
    // newFile was not in cache so it was never hashed
    expect(diff.hashes.has(newFile)).toBe(false);
    // Hashes should be valid SHA-256 hex strings
    expect(diff.hashes.get(unchangedFile)).toMatch(/^[a-f0-9]{64}$/);
    expect(diff.hashes.get(changedFile)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("loadCache", () => {
  const tsConfigPath = () => path.join(tmpDir, "tsconfig.json");
  const cachePath = () => path.join(tmpDir, "cache.json");

  async function writeTsConfig(content = '{"compilerOptions":{}}') {
    await fs.writeFile(tsConfigPath(), content);
  }

  async function writeValidCache(overrides: Partial<CacheManifest> = {}) {
    await writeTsConfig();
    const tsConfigHash = await hashFileContents(tsConfigPath());
    const manifest: CacheManifest = {
      cacheVersion: CACHE_VERSION,
      indexVersion: "1.0.0",
      tsConfigHash,
      pluginNames: [],
      files: {},
      ...overrides,
    };
    await fs.writeFile(cachePath(), JSON.stringify(manifest));
    return manifest;
  }

  it("returns null for missing file", async () => {
    await writeTsConfig();
    const result = await loadCache({
      cachePath: cachePath(),
      tsConfigFilePath: tsConfigPath(),
      pluginNames: [],
      indexVersion: "1.0.0",
    });
    expect(result).toBeNull();
  });

  it("returns null for corrupt JSON", async () => {
    await writeTsConfig();
    await fs.writeFile(cachePath(), "not json{{{");
    const result = await loadCache({
      cachePath: cachePath(),
      tsConfigFilePath: tsConfigPath(),
      pluginNames: [],
      indexVersion: "1.0.0",
    });
    expect(result).toBeNull();
  });

  it("returns null for malformed envelope (files is not an object)", async () => {
    await writeTsConfig();
    await fs.writeFile(
      cachePath(),
      JSON.stringify({
        cacheVersion: CACHE_VERSION,
        indexVersion: "1.0.0",
        tsConfigHash: "anything",
        pluginNames: [],
        files: "not-an-object",
      })
    );
    const result = await loadCache({
      cachePath: cachePath(),
      tsConfigFilePath: tsConfigPath(),
      pluginNames: [],
      indexVersion: "1.0.0",
    });
    expect(result).toBeNull();
  });

  it("returns null for malformed envelope (missing cacheVersion)", async () => {
    await writeTsConfig();
    await fs.writeFile(
      cachePath(),
      JSON.stringify({
        indexVersion: "1.0.0",
        tsConfigHash: "anything",
        pluginNames: [],
        files: {},
      })
    );
    const result = await loadCache({
      cachePath: cachePath(),
      tsConfigFilePath: tsConfigPath(),
      pluginNames: [],
      indexVersion: "1.0.0",
    });
    expect(result).toBeNull();
  });

  it("returns null for wrong cacheVersion", async () => {
    await writeValidCache({ cacheVersion: "999" });
    const result = await loadCache({
      cachePath: cachePath(),
      tsConfigFilePath: tsConfigPath(),
      pluginNames: [],
      indexVersion: "1.0.0",
    });
    expect(result).toBeNull();
  });

  it("returns null for wrong indexVersion", async () => {
    await writeValidCache();
    const result = await loadCache({
      cachePath: cachePath(),
      tsConfigFilePath: tsConfigPath(),
      pluginNames: [],
      indexVersion: "2.0.0",
    });
    expect(result).toBeNull();
  });

  it("returns null when tsconfig hash changed", async () => {
    await writeValidCache();
    // Modify tsconfig after cache was written
    await fs.writeFile(tsConfigPath(), '{"compilerOptions":{"strict":true}}');
    const result = await loadCache({
      cachePath: cachePath(),
      tsConfigFilePath: tsConfigPath(),
      pluginNames: [],
      indexVersion: "1.0.0",
    });
    expect(result).toBeNull();
  });

  it("returns null when plugin list changed", async () => {
    await writeValidCache({ pluginNames: ["plugin-a"] });
    const result = await loadCache({
      cachePath: cachePath(),
      tsConfigFilePath: tsConfigPath(),
      pluginNames: ["plugin-b"],
      indexVersion: "1.0.0",
    });
    expect(result).toBeNull();
  });

  it("returns valid manifest when all checks pass", async () => {
    const manifest = await writeValidCache();
    const result = await loadCache({
      cachePath: cachePath(),
      tsConfigFilePath: tsConfigPath(),
      pluginNames: [],
      indexVersion: "1.0.0",
    });
    expect(result).not.toBeNull();
    expect(result!.manifest).toEqual(manifest);
    expect(result!.tsConfigHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("writeCache → loadCache round-trip", async () => {
    await writeTsConfig();
    const tsConfigHash = await hashFileContents(tsConfigPath());

    const manifest: CacheManifest = {
      cacheVersion: CACHE_VERSION,
      indexVersion: "1.0.0",
      tsConfigHash,
      pluginNames: ["my-plugin"],
      files: {
        "src/foo.ts": {
          contentHash: "abc123",
          symbols: [
            {
              id: "src/foo.ts#bar",
              kind: "function",
              name: "bar",
              filePath: "src/foo.ts",
              exported: true,
            },
          ],
        },
      },
    };

    const cp = path.join(tmpDir, "sub", "cache.json");
    await writeCache(cp, manifest);

    const loaded = await loadCache({
      cachePath: cp,
      tsConfigFilePath: tsConfigPath(),
      pluginNames: ["my-plugin"],
      indexVersion: "1.0.0",
    });

    expect(loaded).not.toBeNull();
    expect(loaded!.manifest).toEqual(manifest);
    expect(loaded!.tsConfigHash).toBe(tsConfigHash);
  });
});

describe("computeDiff parallel hashing", () => {
  it("correctly classifies many files with parallel hashing", async () => {
    // Create 100 files
    const files: string[] = [];
    for (let i = 0; i < 100; i++) {
      const filePath = path.join(tmpDir, `file${i}.ts`);
      await fs.writeFile(filePath, `export const x${i} = ${i};`);
      files.push(filePath);
    }

    // Hash the first 50 files to build a cache
    const cacheFiles: Record<string, { contentHash: string; symbols: [] }> = {};
    for (let i = 0; i < 50; i++) {
      const relPath = `file${i}.ts`;
      const hash = await hashFileContents(files[i]);
      cacheFiles[relPath] = { contentHash: hash, symbols: [] };
    }

    const cache: CacheManifest = {
      cacheVersion: CACHE_VERSION,
      indexVersion: "1.0.0",
      tsConfigHash: "abc",
      pluginNames: [],
      files: cacheFiles,
    };

    const diff = await computeDiff(files, tmpDir, cache);

    // First 50 should be unchanged (hashes match)
    expect(diff.unchanged.length).toBe(50);
    // Last 50 should be changed (not in cache)
    expect(diff.changed.length).toBe(50);
    expect(diff.deleted).toEqual([]);

    // Verify the unchanged files are the first 50
    const unchangedSet = new Set(diff.unchanged);
    for (let i = 0; i < 50; i++) {
      expect(unchangedSet.has(files[i])).toBe(true);
    }
    // Verify the changed files are the last 50
    const changedSet = new Set(diff.changed);
    for (let i = 50; i < 100; i++) {
      expect(changedSet.has(files[i])).toBe(true);
    }
  });
});

describe("computeDiff mtime fast path", () => {
  it("skips hashing when cached mtimeMs matches current stat", async () => {
    const file = path.join(tmpDir, "stable.ts");
    await fs.writeFile(file, "export const a = 1;");
    const hash = await hashFileContents(file);
    const stat = await fs.stat(file);

    const cache: CacheManifest = {
      cacheVersion: CACHE_VERSION,
      indexVersion: "1.0.0",
      tsConfigHash: "abc",
      pluginNames: [],
      files: {
        "stable.ts": { contentHash: hash, symbols: [], mtimeMs: stat.mtimeMs },
      },
    };

    const diff = await computeDiff([file], tmpDir, cache);

    expect(diff.unchanged).toEqual([file]);
    expect(diff.changed).toEqual([]);
    // mtime fast path: no hash was computed (hashes map should be empty for this file)
    expect(diff.hashes.has(file)).toBe(false);
    // mtimes map should still have the stat value
    expect(diff.mtimes.has(file)).toBe(true);
    expect(diff.mtimes.get(file)).toBe(stat.mtimeMs);
  });

  it("falls back to hash when cached entry has no mtimeMs (old cache)", async () => {
    const file = path.join(tmpDir, "old-cache.ts");
    await fs.writeFile(file, "export const b = 2;");
    const hash = await hashFileContents(file);

    // Old cache entry without mtimeMs
    const cache: CacheManifest = {
      cacheVersion: CACHE_VERSION,
      indexVersion: "1.0.0",
      tsConfigHash: "abc",
      pluginNames: [],
      files: {
        "old-cache.ts": { contentHash: hash, symbols: [] },
      },
    };

    const diff = await computeDiff([file], tmpDir, cache);

    expect(diff.unchanged).toEqual([file]);
    expect(diff.changed).toEqual([]);
    // Without mtimeMs, hash fallback was used
    expect(diff.hashes.has(file)).toBe(true);
    expect(diff.hashes.get(file)).toBe(hash);
    // mtimes should still be populated from stat
    expect(diff.mtimes.has(file)).toBe(true);
  });

  it("detects change when mtime differs and content differs", async () => {
    const file = path.join(tmpDir, "changed-mtime.ts");
    await fs.writeFile(file, "export const c = 3;");
    const oldHash = await hashFileContents(file);

    const cache: CacheManifest = {
      cacheVersion: CACHE_VERSION,
      indexVersion: "1.0.0",
      tsConfigHash: "abc",
      pluginNames: [],
      files: {
        "changed-mtime.ts": { contentHash: oldHash, symbols: [], mtimeMs: 1000 },
      },
    };

    // Modify file content (mtime will also change)
    await fs.writeFile(file, "export const c = 999;");

    const diff = await computeDiff([file], tmpDir, cache);

    expect(diff.changed).toEqual([file]);
    expect(diff.unchanged).toEqual([]);
    expect(diff.hashes.has(file)).toBe(true);
    expect(diff.mtimes.has(file)).toBe(true);
  });

  it("returns mtimes map in DiffResult even with null cache", async () => {
    const file = path.join(tmpDir, "no-cache.ts");
    await fs.writeFile(file, "export const d = 4;");

    const diff = await computeDiff([file], tmpDir, null);

    expect(diff.mtimes).toBeInstanceOf(Map);
    // No cache means no stat was performed
    expect(diff.mtimes.size).toBe(0);
  });
});

describe("toRelativePosixPath", () => {
  it("converts to forward-slash relative path", () => {
    const result = toRelativePosixPath("/project/src/foo.ts", "/project");
    expect(result).toBe("src/foo.ts");
  });
});
