import { Project, ScriptKind, ts } from "ts-morph";
import path from "node:path";
import fs from "node:fs/promises";
import { DocIndexSchema, type DocIndex, type SymbolDoc } from "./schema.js";
import { extractFileSymbols } from "./extractor.js";
import type { ArmillaryPlugin } from "./plugins.js";
import { findPluginFiles } from "./plugins.js";
import {
  loadCache,
  computeDiff,
  writeCache,
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

export async function generateDocIndex(
  options: IndexerOptions
): Promise<DocIndex> {
  const { tsConfigFilePath, projectRoot, plugins, onProgress } = options;
  const incremental = options.incremental ?? true;
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
  const project = new Project({
    tsConfigFilePath,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });

  // Filter, convert to relative paths, and sort for determinism
  const filteredPaths = allFilePaths
    .filter((fp) => !isExcluded(fp))
    .sort((a, b) => {
      const aRel = toRelativePosixPath(a, projectRoot);
      const bRel = toRelativePosixPath(b, projectRoot);
      return aRel.localeCompare(bRel);
    });

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

  // Load cache for incremental builds
  const pluginNames = plugins ? plugins.map((p) => p.name).sort() : [];
  const cacheResult: LoadCacheResult | null = incremental
    ? await loadCache({ cachePath, tsConfigFilePath: configPath, pluginNames, indexVersion })
    : null;
  const cache = cacheResult?.manifest ?? null;
  const tsConfigHash = cacheResult?.tsConfigHash ?? null;

  // New file entries map to build the updated cache
  const newFileEntries: Record<string, FileEntry> = {};

  // Filter out plugin-claimed files so progress count is accurate
  const tsFiles = filteredPaths.filter((fp) => !pluginClaimedExtensions.has(path.extname(fp).toLowerCase()));

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
        newFileEntries[relPath] = entry;
      }
    }
  }

  // Re-extract only changed TS files
  for (let i = 0; i < tsDiff.changed.length; i++) {
    const filePath = tsDiff.changed[i];
    onProgress?.({ phase: "indexing", current: i + 1, total: tsDiff.changed.length, file: toRelativePosixPath(filePath, projectRoot) });
    const sourceFile = project.addSourceFileAtPath(filePath);
    const symbols = extractFileSymbols(sourceFile, projectRoot);
    allSymbols.push(...symbols);
    project.removeSourceFile(sourceFile);

    // Store in cache entries
    const relPath = toRelativePosixPath(filePath, projectRoot);
    const contentHash = await hashFileContents(filePath);
    newFileEntries[relPath] = { contentHash, symbols };
  }

  // Process plugins
  if (plugins && plugins.length > 0) {
    const pluginContext = { projectRoot, tsConfigFilePath, project };
    const initializedPlugins: ArmillaryPlugin[] = [];

    try {
      // Initialize all plugins, tracking which ones succeed
      for (let i = 0; i < plugins.length; i++) {
        const plugin = plugins[i];
        await plugin.init?.(pluginContext);
        initializedPlugins.push(plugin);
      }

      // Discover plugin files
      const pluginFileLists: string[][] = [];
      for (const plugin of plugins) {
        const files = await findPluginFiles(projectRoot, plugin.extensions, EXCLUDED_PATTERNS);
        pluginFileLists.push(files);
      }
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
            newFileEntries[relPath] = entry;
          }
        }
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

          pluginFileIndex++;
          onProgress?.({ phase: "plugins", current: pluginFileIndex, total: totalChangedPluginFiles, file: toRelativePosixPath(filePath, projectRoot) });
          const content = await fs.readFile(filePath, "utf-8");
          const relativePath = toRelativePosixPath(filePath, projectRoot);
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
            const sf = project.getSourceFile(filePath);
            if (sf) project.removeSourceFile(sf);
          } else if (plugin.extract) {
            const tsCode = plugin.extract(filePath, content);
            if (tsCode) {
              const virtualPath = filePath + ".ts";
              const sf = project.createSourceFile(virtualPath, tsCode, {
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
              project.removeSourceFile(sf);
            }
          }

          // Store in cache entries, merging if multiple plugins process the same file
          const contentHash = await hashFileContents(filePath);
          const existingEntry = newFileEntries[relativePath];
          if (existingEntry) {
            newFileEntries[relativePath] = {
              contentHash,
              symbols: [...existingEntry.symbols, ...fileSymbols],
            };
          } else {
            newFileEntries[relativePath] = { contentHash, symbols: fileSymbols };
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
  allSymbols.sort((a, b) => a.id.localeCompare(b.id));

  const docIndex: DocIndex = {
    version: indexVersion,
    generatedAt: new Date().toISOString(),
    projectRoot,
    symbols: allSymbols,
  };

  const validated = DocIndexSchema.parse(docIndex);

  // Write output
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(validated, null, 2) + "\n");

  // Write cache
  if (incremental) {
    const newManifest: CacheManifest = {
      cacheVersion: CACHE_VERSION,
      indexVersion,
      tsConfigHash: tsConfigHash ?? await hashFileContents(configPath),
      pluginNames,
      files: newFileEntries,
    };
    await writeCache(cachePath, newManifest);
  }

  return validated;
}
