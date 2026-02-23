import { Project, ScriptKind, ts } from "ts-morph";
import path from "node:path";
import fs from "node:fs/promises";
import type { DocIndex, SymbolDoc } from "./schema.js";
import { extractFileSymbols } from "./extractor.js";
import type { ArmillaryPlugin } from "./plugins.js";
import { findAllPluginFiles } from "./plugins.js";
import {
  loadCache,
  computeDiff,
  hashFileContents,
  toRelativePosixPath,
  CACHE_VERSION,
  type CacheManifest,
  type FileEntry,
  type LoadCacheResult,
} from "./cache.js";

export interface ProgressInfo {
  phase: string;
  current: number;
  total: number;
  file?: string;
}

export interface IndexerOptions {
  tsConfigFilePath: string;
  projectRoot: string;
  outputPath?: string;
  plugins?: ArmillaryPlugin[];
  onProgress?: (info: ProgressInfo) => void;
  /** Enable incremental caching. Default: true */
  incremental?: boolean;
  /** Files to process before recreating the ts-morph Project to flush
   *  type checker caches. Default: 50 */
  batchSize?: number;
}

export const EXCLUDED_PATTERNS = [
  /node_modules/,
  /\.next/,
  /dist\//,
  /\.d\.ts$/,
];

function isExcluded(filePath: string): boolean {
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(filePath));
}

function createFreshProject(tsConfigFilePath: string): Project {
  return new Project({
    tsConfigFilePath,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });
}

export async function generateDocIndex(
  options: IndexerOptions
): Promise<DocIndex> {
  const { tsConfigFilePath, projectRoot, plugins, onProgress } = options;
  const incremental = options.incremental ?? true;
  const batchSize = options.batchSize ?? 50;
  const outputPath =
    options.outputPath ?? path.join(projectRoot, ".armillary-mcp-docs", "index.json");
  const outputDir = path.dirname(outputPath);
  const cachePath = path.join(outputDir, "cache.json");
  const indexVersion = "1.0.0";

  // Resolve file list from tsconfig without loading ASTs (lightweight)
  const configPath = path.resolve(tsConfigFilePath);
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    const msg = ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n");
    throw new Error(`Failed to read tsconfig at ${configPath}: ${msg}`);
  }
  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath)
  );
  if (parsedConfig.errors.length > 0) {
    const msgs = parsedConfig.errors
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
      .join("\n");
    throw new Error(`tsconfig errors in ${configPath}:\n${msgs}`);
  }
  const allFilePaths = parsedConfig.fileNames;

  // Create project with compiler options from tsconfig but skip loading all files upfront
  let project = createFreshProject(tsConfigFilePath);

  const allSymbols: SymbolDoc[] = [];

  // Collect plugin-claimed extensions so we skip ts-morph extraction for those files;
  // plugins are responsible for handling these files independently of the ts-morph Project.
  const pluginClaimedExtensions = new Set<string>();
  if (plugins) {
    for (const plugin of plugins) {
      for (const ext of plugin.extensions) {
        pluginClaimedExtensions.add(ext.toLowerCase());
      }
    }
  }

  // Single pass: filter excluded paths and split into TS vs plugin-claimed files
  const tsFiles = allFilePaths.filter(
    (fp) => !isExcluded(fp) && !pluginClaimedExtensions.has(path.extname(fp).toLowerCase())
  );

  // Load cache for incremental builds
  const pluginNames = plugins ? plugins.map((p) => p.name).sort() : [];
  const cacheResult: LoadCacheResult | null = incremental
    ? await loadCache({ cachePath, tsConfigFilePath: configPath, pluginNames, indexVersion })
    : null;
  const cache = cacheResult?.manifest ?? null;
  const tsConfigHash = cacheResult?.tsConfigHash ?? null;

  // New file entries map to build the updated cache
  const newFileEntries: Record<string, FileEntry> = {};

  // Compute diff for TS files.
  // Note: computeDiff checks against the full cache (TS + plugin files). The `deleted`
  // field may include plugin files here (and vice versa below), but `deleted` is not
  // consumed — removal is implicit since deleted files aren't in currentFiles.
  const tsDiff = await computeDiff(tsFiles, projectRoot, cache);

  // Carry forward unchanged TS file symbols from cache
  if (cache) {
    for (const absPath of tsDiff.unchanged) {
      const relPath = toRelativePosixPath(absPath, projectRoot);
      const entry = cache.files[relPath];
      if (entry) {
        allSymbols.push(...entry.symbols);
        // Update mtimeMs if we got a fresh stat (handles "mtime changed but content same")
        const freshMtime = tsDiff.mtimes.get(absPath);
        if (freshMtime !== undefined && freshMtime !== entry.mtimeMs) {
          newFileEntries[relPath] = { ...entry, mtimeMs: freshMtime };
        } else {
          newFileEntries[relPath] = entry;
        }
      }
    }
  }

  // Re-extract only changed TS files
  for (let i = 0; i < tsDiff.changed.length; i++) {
    if (i > 0 && i % batchSize === 0) {
      project = createFreshProject(tsConfigFilePath);
    }
    const filePath = tsDiff.changed[i];
    const relPath = toRelativePosixPath(filePath, projectRoot);
    onProgress?.({ phase: "indexing", current: i + 1, total: tsDiff.changed.length, file: relPath });
    const sourceFile = project.addSourceFileAtPath(filePath);
    const symbols = extractFileSymbols(sourceFile, projectRoot);
    allSymbols.push(...symbols);
    project.removeSourceFile(sourceFile);

    // Store in cache entries — reuse hash from diff when available
    const contentHash = tsDiff.hashes.get(filePath) ?? await hashFileContents(filePath);
    const mtimeMs = tsDiff.mtimes.get(filePath) ?? (await fs.stat(filePath)).mtimeMs;
    newFileEntries[relPath] = { contentHash, symbols, mtimeMs };
  }

  // Process plugins
  if (plugins && plugins.length > 0) {
    // Create a fresh project for the plugin phase so we don't carry TS-phase cache bloat
    let pluginProject = createFreshProject(tsConfigFilePath);
    const pluginContext = { projectRoot, tsConfigFilePath, project: pluginProject };
    const initializedPlugins: ArmillaryPlugin[] = [];

    try {
      // Initialize all plugins, tracking which ones succeed
      for (let i = 0; i < plugins.length; i++) {
        const plugin = plugins[i];
        await plugin.init?.(pluginContext);
        initializedPlugins.push(plugin);
      }

      // Discover plugin files — single walk for all plugins
      const pluginFileLists = await findAllPluginFiles(projectRoot, plugins, EXCLUDED_PATTERNS);
      const allPluginFiles = pluginFileLists.flat();

      // Compute diff for plugin files
      const pluginDiff = await computeDiff(allPluginFiles, projectRoot, cache);

      // Carry forward unchanged plugin file symbols from cache
      if (cache) {
        for (const absPath of pluginDiff.unchanged) {
          const relPath = toRelativePosixPath(absPath, projectRoot);
          const entry = cache.files[relPath];
          if (entry) {
            allSymbols.push(...entry.symbols);
            const freshMtime = pluginDiff.mtimes.get(absPath);
            if (freshMtime !== undefined && freshMtime !== entry.mtimeMs) {
              newFileEntries[relPath] = { ...entry, mtimeMs: freshMtime };
            } else {
              newFileEntries[relPath] = entry;
            }
          }
        }
      }

      // Pre-compute relative paths for changed plugin files
      const pluginRelPaths = new Map<string, string>();
      for (const absPath of pluginDiff.changed) {
        pluginRelPaths.set(absPath, toRelativePosixPath(absPath, projectRoot));
      }

      // Build a set of changed plugin files for quick lookup
      const changedPluginSet = new Set(pluginDiff.changed);

      let pluginFileIndex = 0;
      const totalChangedPluginFiles = pluginDiff.changed.length;

      for (let pi = 0; pi < plugins.length; pi++) {
        const plugin = plugins[pi];
        const files = pluginFileLists[pi];

        for (const filePath of files) {
          if (!changedPluginSet.has(filePath)) continue;

          // Periodically recreate the project and re-init plugins to flush caches
          if (pluginFileIndex > 0 && pluginFileIndex % batchSize === 0) {
            for (const p of initializedPlugins) {
              await p.dispose?.();
            }
            pluginProject = createFreshProject(tsConfigFilePath);
            for (const p of initializedPlugins) {
              await p.init?.({ projectRoot, tsConfigFilePath, project: pluginProject });
            }
          }

          pluginFileIndex++;
          const relativePath = pluginRelPaths.get(filePath)!;
          onProgress?.({ phase: "plugins", current: pluginFileIndex, total: totalChangedPluginFiles, file: relativePath });
          const content = await fs.readFile(filePath, "utf-8");
          const fileSymbols: SymbolDoc[] = [];

          if (plugin.extractSymbols) {
            const symbols = await plugin.extractSymbols(filePath, content);
            for (const sym of symbols) {
              const filePathChanged = !sym.filePath || path.isAbsolute(sym.filePath);
              if (filePathChanged) {
                sym.filePath = relativePath;
              }
              if (!sym.id || filePathChanged) {
                sym.id = `${sym.filePath}#${sym.name}`;
              }
            }
            fileSymbols.push(...symbols);
            allSymbols.push(...symbols);
            // Release the source file to free memory
            const sf = pluginProject.getSourceFile(filePath);
            if (sf) pluginProject.removeSourceFile(sf);
          } else if (plugin.extract) {
            const tsCode = plugin.extract(filePath, content);
            if (tsCode) {
              const virtualPath = filePath + ".ts";
              const sf = pluginProject.createSourceFile(virtualPath, tsCode, {
                scriptKind: ScriptKind.TS,
                overwrite: true,
              });
              const symbols = extractFileSymbols(sf, projectRoot);
              // Rewrite filePath to point to the original file, not the virtual .ts
              for (const sym of symbols) {
                sym.filePath = relativePath;
                sym.id = `${relativePath}#${sym.name}`;
              }
              fileSymbols.push(...symbols);
              allSymbols.push(...symbols);
              pluginProject.removeSourceFile(sf);
            }
          }

          // Store in cache entries, merging if multiple plugins process the same file
          const contentHash = pluginDiff.hashes.get(filePath) ?? await hashFileContents(filePath);
          const mtimeMs = pluginDiff.mtimes.get(filePath) ?? (await fs.stat(filePath)).mtimeMs;
          const existingEntry = newFileEntries[relativePath];
          if (existingEntry) {
            newFileEntries[relativePath] = {
              contentHash,
              symbols: [...existingEntry.symbols, ...fileSymbols],
              mtimeMs,
            };
          } else {
            newFileEntries[relativePath] = { contentHash, symbols: fileSymbols, mtimeMs };
          }
        }
      }
    } finally {
      // Only dispose plugins that were successfully initialized
      for (const plugin of initializedPlugins) {
        await plugin.dispose?.();
      }
    }
  }

  // Sort all symbols by id for determinism
  allSymbols.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const docIndex: DocIndex = {
    version: indexVersion,
    generatedAt: new Date().toISOString(),
    projectRoot,
    symbols: allSymbols,
  };

  // Write output and cache in parallel (skip runtime validation — data is
  // constructed by trusted code; read-side validation in server-handlers.ts
  // covers deserialized data)
  await fs.mkdir(outputDir, { recursive: true });
  const writes: Promise<void>[] = [
    fs.writeFile(outputPath, JSON.stringify(docIndex, null, 2) + "\n"),
  ];
  if (incremental) {
    const newManifest: CacheManifest = {
      cacheVersion: CACHE_VERSION,
      indexVersion,
      tsConfigHash: tsConfigHash ?? await hashFileContents(configPath),
      pluginNames,
      files: newFileEntries,
    };
    writes.push(fs.writeFile(cachePath, JSON.stringify(newManifest)));
  }
  await Promise.all(writes);

  return docIndex;
}
