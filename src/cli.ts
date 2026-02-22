#!/usr/bin/env node
import path from "node:path";
import { generateDocIndex } from "./indexer.js";
import { watchAndRegenerate } from "./watcher.js";

function timestamp(): string {
  return new Date().toLocaleTimeString();
}

function showUsage(): void {
  console.log(`Usage: armillary-mcp <command>

Commands:
  build   Generate documentation index and exit
  watch   Watch for changes and regenerate on save`);
}

async function runBuild(): Promise<void> {
  const projectRoot = process.cwd();
  const tsConfigFilePath = path.join(projectRoot, "tsconfig.json");

  console.log(`Generating documentation index...`);
  console.log(`  Project root: ${projectRoot}`);
  console.log(`  tsconfig: ${tsConfigFilePath}`);

  const index = await generateDocIndex({ tsConfigFilePath, projectRoot });

  console.log(`\nGenerated index with ${index.symbols.length} symbols:`);
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

  const handle = await watchAndRegenerate({
    tsConfigFilePath,
    projectRoot,
    onBuildStart: () => {
      console.log(`\n[${timestamp()}] Rebuilding index...`);
    },
    onBuildComplete: (symbolCount) => {
      console.log(`[${timestamp()}] Index built with ${symbolCount} symbols.`);
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
