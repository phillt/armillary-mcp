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
  it("with null cache, all files are changed", async () => {
    const file1 = path.join(tmpDir, "a.ts");
    const file2 = path.join(tmpDir, "b.ts");
    await fs.writeFile(file1, "export const a = 1;");
    await fs.writeFile(file2, "export const b = 2;");

    const diff = await computeDiff([file1, file2], tmpDir, null);

    expect(diff.changed).toEqual([file1, file2]);
    expect(diff.unchanged).toEqual([]);
    expect(diff.deleted).toEqual([]);
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

  it("returns null for malformed structure", async () => {
    await writeTsConfig();
    // Valid JSON but files entry has wrong shape (missing symbols array)
    const tsConfigHash = await hashFileContents(tsConfigPath());
    await fs.writeFile(
      cachePath(),
      JSON.stringify({
        cacheVersion: CACHE_VERSION,
        indexVersion: "1.0.0",
        tsConfigHash,
        pluginNames: [],
        files: {
          "src/foo.ts": { contentHash: "abc", symbols: "not-an-array" },
        },
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

describe("toRelativePosixPath", () => {
  it("converts to forward-slash relative path", () => {
    const result = toRelativePosixPath("/project/src/foo.ts", "/project");
    expect(result).toBe("src/foo.ts");
  });
});
