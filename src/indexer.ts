import { Project } from "ts-morph";
import path from "node:path";
import fs from "node:fs/promises";
import { DocIndexSchema, type DocIndex, type SymbolDoc } from "./schema.js";
import { extractFileSymbols } from "./extractor.js";

export interface IndexerOptions {
  tsConfigFilePath: string;
  projectRoot: string;
  outputPath?: string;
}

const EXCLUDED_PATTERNS = [
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
  const { tsConfigFilePath, projectRoot } = options;
  const outputPath =
    options.outputPath ?? path.join(projectRoot, ".mcp-docs", "index.json");

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

  for (const sourceFile of filteredFiles) {
    const symbols = extractFileSymbols(sourceFile, projectRoot);
    allSymbols.push(...symbols);
  }

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
