import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createBuildController, watchAndRegenerate } from "../watcher.js";

describe("createBuildController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces multiple rapid schedule calls into a single build", async () => {
    const buildFn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const controller = createBuildController(buildFn, 300);

    controller.scheduleRebuild();
    controller.scheduleRebuild();
    controller.scheduleRebuild();

    await vi.advanceTimersByTimeAsync(300);

    expect(buildFn).toHaveBeenCalledTimes(1);
  });

  it("resets debounce timer on each new schedule call", async () => {
    const buildFn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const controller = createBuildController(buildFn, 300);

    controller.scheduleRebuild();
    await vi.advanceTimersByTimeAsync(200);
    expect(buildFn).not.toHaveBeenCalled();

    // Reset the timer
    controller.scheduleRebuild();
    await vi.advanceTimersByTimeAsync(200);
    expect(buildFn).not.toHaveBeenCalled();

    // Now the full 300ms from last schedule
    await vi.advanceTimersByTimeAsync(100);
    expect(buildFn).toHaveBeenCalledTimes(1);
  });

  it("queues exactly one rebuild when change arrives during a build", async () => {
    let resolveBuild!: () => void;
    let buildCount = 0;
    const buildFn = vi.fn<() => Promise<void>>().mockImplementation(() => {
      buildCount++;
      return new Promise<void>((resolve) => {
        resolveBuild = resolve;
      });
    });

    const controller = createBuildController(buildFn, 300);

    // Start first build
    controller.scheduleRebuild();
    await vi.advanceTimersByTimeAsync(300);
    expect(controller.getState()).toBe("building");
    expect(buildCount).toBe(1);

    // Schedule during build — should queue
    controller.scheduleRebuild();
    controller.scheduleRebuild(); // second call shouldn't add another queue
    expect(controller.getState()).toBe("build_queued");

    // Finish first build — should immediately start queued build
    resolveBuild();
    await vi.advanceTimersByTimeAsync(0);
    expect(buildCount).toBe(2);

    // Finish second build
    resolveBuild();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState()).toBe("idle");
    expect(buildCount).toBe(2);
  });

  it("returns to idle after build completes", async () => {
    const buildFn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const controller = createBuildController(buildFn, 300);

    expect(controller.getState()).toBe("idle");

    controller.scheduleRebuild();
    await vi.advanceTimersByTimeAsync(300);

    expect(controller.getState()).toBe("idle");
  });

  it("waitForIdle resolves immediately when already idle", async () => {
    const buildFn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const controller = createBuildController(buildFn, 300);

    // Should resolve without needing to advance timers
    await controller.waitForIdle();
    expect(controller.getState()).toBe("idle");
  });

  it("waitForIdle resolves after in-progress build completes", async () => {
    let resolveBuild!: () => void;
    const buildFn = vi.fn<() => Promise<void>>().mockImplementation(
      () => new Promise<void>((resolve) => { resolveBuild = resolve; })
    );

    const controller = createBuildController(buildFn, 300);

    controller.scheduleRebuild();
    await vi.advanceTimersByTimeAsync(300);
    expect(controller.getState()).toBe("building");

    let idleResolved = false;
    const idlePromise = controller.waitForIdle().then(() => {
      idleResolved = true;
    });

    expect(idleResolved).toBe(false);

    resolveBuild();
    await vi.advanceTimersByTimeAsync(0);
    await idlePromise;

    expect(idleResolved).toBe(true);
    expect(controller.getState()).toBe("idle");
  });

  it("continues working after buildFn throws", async () => {
    let callCount = 0;
    const buildFn = vi.fn<() => Promise<void>>().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("build failed");
      }
    });

    const controller = createBuildController(buildFn, 300);

    // First build — will throw
    controller.scheduleRebuild();
    await vi.advanceTimersByTimeAsync(300);
    expect(controller.getState()).toBe("idle");

    // Second build — should work fine
    controller.scheduleRebuild();
    await vi.advanceTimersByTimeAsync(300);
    expect(controller.getState()).toBe("idle");
    expect(buildFn).toHaveBeenCalledTimes(2);
  });
});

describe("watchAndRegenerate", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-docs-watch-"));

    await fs.writeFile(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          declaration: true,
          strict: true,
          skipLibCheck: true,
        },
        include: ["src"],
      })
    );

    await fs.mkdir(path.join(tmpDir, "src"));

    await fs.writeFile(
      path.join(tmpDir, "src", "initial.ts"),
      `export function hello() { return "hello"; }`
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("produces initial index on startup", async () => {
    const onBuildComplete = vi.fn();

    const handle = await watchAndRegenerate({
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
      debounceMs: 100,
      onBuildComplete,
    });

    try {
      // Initial build should have fired onBuildComplete
      expect(onBuildComplete).toHaveBeenCalledTimes(1);
      expect(onBuildComplete).toHaveBeenCalledWith(1); // one symbol: hello

      const indexPath = path.join(tmpDir, ".mcp-docs", "index.json");
      const content = JSON.parse(await fs.readFile(indexPath, "utf-8"));
      expect(content.symbols).toHaveLength(1);
      expect(content.symbols[0].name).toBe("hello");
    } finally {
      await handle.close();
    }
  });

  it("rebuilds when a new TS file is added", async () => {
    const onBuildComplete = vi.fn();

    const handle = await watchAndRegenerate({
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
      watchPaths: [path.join(tmpDir, "src")],
      debounceMs: 100,
      onBuildComplete,
    });

    try {
      // Reset after initial build
      onBuildComplete.mockClear();

      // Add a new file
      await fs.writeFile(
        path.join(tmpDir, "src", "newfile.ts"),
        `export function world() { return "world"; }`
      );

      // Wait for the rebuild (debounce + build time)
      await vi.waitFor(
        () => {
          expect(onBuildComplete).toHaveBeenCalled();
        },
        { timeout: 10_000, interval: 100 }
      );

      const indexPath = path.join(tmpDir, ".mcp-docs", "index.json");
      const content = JSON.parse(await fs.readFile(indexPath, "utf-8"));
      expect(content.symbols.length).toBeGreaterThanOrEqual(2);
    } finally {
      await handle.close();
    }
  }, 15_000);
});
