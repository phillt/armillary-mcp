import path from "node:path";
import { generateDocIndex } from "./indexer.js";
import { watchAndRegenerate } from "./watcher.js";

const isWatchMode = process.argv.includes("--watch") || process.argv.includes("-w");

function timestamp(): string {
  return new Date().toLocaleTimeString();
}

async function main() {
  const projectRoot = process.cwd();
  const tsConfigFilePath = path.join(projectRoot, "tsconfig.json");

  if (isWatchMode) {
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
  } else {
    console.log(`Generating documentation index...`);
    console.log(`  Project root: ${projectRoot}`);
    console.log(`  tsconfig: ${tsConfigFilePath}`);

    const index = await generateDocIndex({ tsConfigFilePath, projectRoot });

    console.log(`\nGenerated index with ${index.symbols.length} symbols:`);
    for (const sym of index.symbols) {
      console.log(`  ${sym.kind.padEnd(10)} ${sym.id}`);
    }
    console.log(`\nOutput written to .mcp-docs/index.json`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
