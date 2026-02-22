export { generateDocIndex, type IndexerOptions } from "./indexer.js";
export type { DocIndex, SymbolDoc } from "./schema.js";
export { DocIndexSchema, SymbolDocSchema } from "./schema.js";
export {
  watchAndRegenerate,
  createBuildController,
  type WatcherOptions,
  type WatcherHandle,
  type BuildController,
} from "./watcher.js";
export {
  loadDocIndex,
  listSymbols,
  getSymbol,
  searchSymbols,
} from "./server-handlers.js";
