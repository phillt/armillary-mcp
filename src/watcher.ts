import chokidar, { type FSWatcher } from "chokidar";
import { generateDocIndex, type IndexerOptions } from "./indexer.js";

export interface WatcherOptions extends IndexerOptions {
  debounceMs?: number;
  watchPaths?: string[];
  onBuildStart?: () => void;
  onBuildComplete?: (symbolCount: number) => void;
  onBuildError?: (error: unknown) => void;
}

export interface WatcherHandle {
  close(): Promise<void>;
  watcher: FSWatcher;
}

export interface BuildController {
  scheduleRebuild(): void;
  waitForIdle(): Promise<void>;
  getState(): "idle" | "building" | "build_queued";
}

export function createBuildController(
  buildFn: () => Promise<void>,
  debounceMs: number
): BuildController {
  let state: "idle" | "building" | "build_queued" = "idle";
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let idleResolvers: Array<() => void> = [];

  function resolveIdleWaiters() {
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }

  async function runBuild(): Promise<void> {
    state = "building";
    try {
      await buildFn();
    } catch {
      // Error swallowed — watcher continues
    }

    // state may have been mutated to "build_queued" by scheduleRebuild()
    // during the await above — read via getState() to avoid TS narrowing
    if (getState() === "build_queued") {
      // Another change came in during the build — rebuild immediately
      await runBuild();
      return;
    }

    state = "idle";
    resolveIdleWaiters();
  }

  function scheduleRebuild() {
    if (state === "building") {
      state = "build_queued";
      return;
    }

    if (state === "build_queued") {
      // Already queued, nothing more to do
      return;
    }

    // state === "idle": (re)start debounce timer
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runBuild();
    }, debounceMs);
  }

  function waitForIdle(): Promise<void> {
    if (state === "idle" && debounceTimer === null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      idleResolvers.push(resolve);
    });
  }

  function getState() {
    return state;
  }

  return { scheduleRebuild, waitForIdle, getState };
}

const IGNORED_PATTERNS = [
  /node_modules/,
  /\.next/,
  /dist\//,
  /\.d\.ts$/,
  /\.armillary-mcp-docs/,
];

function shouldIgnore(
  filePath: string,
  pluginExtensions?: Set<string>
): boolean {
  if (IGNORED_PATTERNS.some((p) => p.test(filePath))) return true;
  // Only filter by extension if the path looks like a file (has an extension).
  // Directories must not be ignored so chokidar can traverse into them.
  if (/\.\w+$/.test(filePath)) {
    if (/\.[tj]sx?$/.test(filePath)) return false;
    if (pluginExtensions) {
      const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
      if (pluginExtensions.has(ext)) return false;
    }
    return true;
  }
  return false;
}

export async function watchAndRegenerate(
  options: WatcherOptions
): Promise<WatcherHandle> {
  const {
    debounceMs = 300,
    watchPaths,
    onBuildStart,
    onBuildComplete,
    onBuildError,
    ...indexerOptions
  } = options;

  const pathsToWatch = watchPaths ?? [indexerOptions.projectRoot];

  // Collect plugin extensions for the watcher
  const pluginExtensions = new Set<string>();
  if (indexerOptions.plugins) {
    for (const plugin of indexerOptions.plugins) {
      for (const ext of plugin.extensions) {
        pluginExtensions.add(ext.toLowerCase());
      }
    }
  }
  const extSet = pluginExtensions.size > 0 ? pluginExtensions : undefined;

  // Initial build
  const initialIndex = await generateDocIndex(indexerOptions);
  onBuildComplete?.(initialIndex.symbols.length);

  const buildFn = async () => {
    onBuildStart?.();
    try {
      const index = await generateDocIndex(indexerOptions);
      onBuildComplete?.(index.symbols.length);
    } catch (error) {
      onBuildError?.(error);
      throw error; // Re-throw so createBuildController catches it
    }
  };

  const controller = createBuildController(buildFn, debounceMs);

  const watcher = chokidar.watch(pathsToWatch, {
    ignoreInitial: true,
    ignored: (filePath: string) => shouldIgnore(filePath, extSet),
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    persistent: true,
  });

  watcher.on("add", () => controller.scheduleRebuild());
  watcher.on("change", () => controller.scheduleRebuild());
  watcher.on("unlink", () => controller.scheduleRebuild());

  // Wait for chokidar to finish its initial scan
  await new Promise<void>((resolve) => {
    watcher.on("ready", () => resolve());
  });

  const handle: WatcherHandle = {
    watcher,
    async close() {
      await watcher.close();
      await controller.waitForIdle();
    },
  };

  return handle;
}
