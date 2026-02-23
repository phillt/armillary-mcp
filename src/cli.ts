import path from "node:path";
import fs from "node:fs/promises";
import { generateDocIndex, type ProgressInfo } from "./indexer.js";
import { watchAndRegenerate } from "./watcher.js";
import { loadPlugins, type ArmillaryPlugin } from "./plugins.js";

function timestamp(): string {
  return new Date().toLocaleTimeString();
}

function showUsage(): void {
  console.log(`Usage: armillary-mcp <command>

Commands:
  build   Generate documentation index and exit
  watch   Watch for changes and regenerate on save`);
}

async function readPluginConfig(projectRoot: string): Promise<string[]> {
  const pkgPath = path.join(projectRoot, "package.json");
  let raw: string;
  try {
    raw = await fs.readFile(pkgPath, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const config = pkg["armillary-mcp"] as
    | Record<string, unknown>
    | undefined;
  if (config && Array.isArray(config.plugins)) {
    return config.plugins.filter(
      (p: unknown): p is string => typeof p === "string"
    );
  }
  return [];
}

async function resolvePlugins(
  projectRoot: string
): Promise<ArmillaryPlugin[] | undefined> {
  const pluginNames = await readPluginConfig(projectRoot);
  if (pluginNames.length === 0) return undefined;

  console.log(`  Plugins: ${pluginNames.join(", ")}`);
  const plugins = await loadPlugins(pluginNames, projectRoot);
  return plugins;
}

async function runBuild(): Promise<void> {
  const projectRoot = process.cwd();
  const tsConfigFilePath = path.join(projectRoot, "tsconfig.json");

  console.log(`Generating documentation index...`);
  console.log(`  Project root: ${projectRoot}`);
  console.log(`  tsconfig: ${tsConfigFilePath}`);

  const plugins = await resolvePlugins(projectRoot);

  let onProgress: ((info: ProgressInfo) => void) | undefined;
  if (process.stdout.isTTY) {
    onProgress = (info: ProgressInfo) => {
      const cols = process.stdout.columns || 80;
      const label = info.phase === "indexing" ? "Indexing" : "Plugins";
      const prefix = `  ${label} [${info.current}/${info.total}] `;
      const file = info.file ?? "";
      const maxFileLen = cols - prefix.length;
      const truncatedFile = maxFileLen < 4 ? "" : file.length > maxFileLen ? "..." + file.slice(-(maxFileLen - 3)) : file;
      const line = prefix + truncatedFile;
      process.stdout.write(`\r${line.padEnd(cols)}`);
    };
  }

  const startTime = performance.now();
  const index = await generateDocIndex({ tsConfigFilePath, projectRoot, plugins, onProgress });
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

  if (process.stdout.isTTY) {
    process.stdout.write("\n");
  }

  console.log(`\nGenerated index with ${index.symbols.length} symbols in ${elapsed}s:`);
  for (const sym of index.symbols) {
    console.log(`  ${sym.kind.padEnd(10)} ${sym.id}`);
  }
  console.log(`\nOutput written to .armillary-mcp-docs/index.json`);
}

async function runWatch(): Promise<void> {
  const projectRoot = process.cwd();
  const tsConfigFilePath = path.join(projectRoot, "tsconfig.json");

  console.log(`[${timestamp()}] Starting watch mode...`);
  console.log(`  Project root: ${projectRoot}`);
  console.log(`  tsconfig: ${tsConfigFilePath}`);

  const plugins = await resolvePlugins(projectRoot);
  const handle = await watchAndRegenerate({
    tsConfigFilePath,
    projectRoot,
    plugins,
    onBuildStart: () => {
      console.log(`\n[${timestamp()}] Rebuilding index...`);
    },
    onBuildComplete: (symbolCount, elapsedMs) => {
      const elapsed = (elapsedMs / 1000).toFixed(2);
      console.log(`[${timestamp()}] Index built with ${symbolCount} symbols in ${elapsed}s.`);
    },
    onBuildError: (error) => {
      console.error(`[${timestamp()}] Build error:`, error);
    },
  });

  const shutdown = async () => {
    console.log(`\n[${timestamp()}] Shutting down watcher...`);
    await handle.close();
    console.log(`[${timestamp()}] Done.`);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  console.log(`[${timestamp()}] Watching for changes. Press Ctrl-C to stop.`);
}

const command = process.argv[2];

switch (command) {
  case "build":
    runBuild().catch((err) => {
      console.error(err);
      process.exit(1);
    });
    break;
  case "watch":
    runWatch().catch((err) => {
      console.error(err);
      process.exit(1);
    });
    break;
  case undefined:
    showUsage();
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    showUsage();
    process.exit(1);
}
