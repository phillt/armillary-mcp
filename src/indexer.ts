import { Project, ScriptKind } from "ts-morph";
import path from "node:path";
import fs from "node:fs/promises";
import { DocIndexSchema, type DocIndex, type SymbolDoc } from "./schema.js";
import { extractFileSymbols } from "./extractor.js";
import type { ArmillaryPlugin } from "./plugins.js";
import { findPluginFiles } from "./plugins.js";

export interface IndexerOptions {
  tsConfigFilePath: string;
  projectRoot: string;
  outputPath?: string;
  plugins?: ArmillaryPlugin[];
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

function toRelativePosixPath(filePath: string, projectRoot: string): string {
  const rel = path.relative(projectRoot, filePath);
  return rel.split(path.sep).join("/");
}

export async function generateDocIndex(
  options: IndexerOptions
): Promise<DocIndex> {
  const { tsConfigFilePath, projectRoot, plugins } = options;
  const outputPath =
    options.outputPath ?? path.join(projectRoot, ".armillary-mcp-docs", "index.json");

  const project = new Project({ tsConfigFilePath });
  const sourceFiles = project.getSourceFiles();

  // Filter and sort source files by relative path for determinism
  const filteredFiles = sourceFiles
    .filter((sf) => !isExcluded(sf.getFilePath()))
    .sort((a, b) => {
      const aRel = toRelativePosixPath(a.getFilePath(), projectRoot);
      const bRel = toRelativePosixPath(b.getFilePath(), projectRoot);
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

  for (const sourceFile of filteredFiles) {
    const ext = path.extname(sourceFile.getFilePath()).toLowerCase();
    if (pluginClaimedExtensions.has(ext)) continue;
    const symbols = extractFileSymbols(sourceFile, projectRoot);
    allSymbols.push(...symbols);
  }

  // Process plugins
  if (plugins && plugins.length > 0) {
    const pluginContext = { projectRoot, tsConfigFilePath, project };
    const initializedPlugins: ArmillaryPlugin[] = [];

    try {
      // Initialize all plugins, tracking which ones succeed
      for (const plugin of plugins) {
        await plugin.init?.(pluginContext);
        initializedPlugins.push(plugin);
      }

      for (const plugin of plugins) {
        const files = await findPluginFiles(
          projectRoot,
          plugin.extensions,
          EXCLUDED_PATTERNS
        );

        for (const filePath of files) {
          const content = await fs.readFile(filePath, "utf-8");

          if (plugin.extractSymbols) {
            const symbols = await plugin.extractSymbols(filePath, content);
            const relativePath = toRelativePosixPath(filePath, projectRoot);
            for (const sym of symbols) {
              const filePathChanged = !sym.filePath || path.isAbsolute(sym.filePath);
              if (filePathChanged) {
                sym.filePath = relativePath;
              }
              if (!sym.id || filePathChanged) {
                sym.id = `${sym.filePath}#${sym.name}`;
              }
            }
            allSymbols.push(...symbols);
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
              const relativePath = toRelativePosixPath(filePath, projectRoot);
              for (const sym of symbols) {
                sym.filePath = relativePath;
                sym.id = `${relativePath}#${sym.name}`;
              }
              allSymbols.push(...symbols);
              project.removeSourceFile(sf);
            }
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
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    projectRoot,
    symbols: allSymbols,
  };

  const validated = DocIndexSchema.parse(docIndex);

  // Write output
  const outputDir = path.dirname(outputPath);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(validated, null, 2) + "\n");

  return validated;
}
