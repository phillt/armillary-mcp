import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { loadPlugins, findPluginFiles, findAllPluginFiles, type ArmillaryPlugin } from "../plugins.js";
import { SymbolDocSchema } from "../schema.js";
import { generateDocIndex } from "../indexer.js";
import { watchAndRegenerate } from "../watcher.js";

// ── validatePlugin / loadPlugins ─────────────────────────────────────

describe("loadPlugins", () => {
  it("loads a plugin from an absolute path (default export)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "armillary-test-"));
    const pluginPath = path.join(tmpDir, "plugin.mjs");
    await fs.writeFile(
      pluginPath,
      `export default {
        name: "test-plugin",
        extensions: [".test"],
        extract(fp, content) { return content; },
      };`
    );

    const plugins = await loadPlugins([pluginPath], tmpDir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe("test-plugin");
    expect(plugins[0].extensions).toEqual([".test"]);
    expect(typeof plugins[0].extract).toBe("function");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("loads a plugin from a relative path", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "armillary-test-"));
    const pluginPath = path.join(tmpDir, "my-plugin.mjs");
    await fs.writeFile(
      pluginPath,
      `export default {
        name: "rel-plugin",
        extensions: [".rel"],
        extractSymbols() { return []; },
      };`
    );

    const plugins = await loadPlugins(["./my-plugin.mjs"], tmpDir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe("rel-plugin");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("rejects a plugin missing name", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "armillary-test-"));
    const pluginPath = path.join(tmpDir, "bad.mjs");
    await fs.writeFile(
      pluginPath,
      `export default { extensions: [".x"], extract() { return ""; } };`
    );

    await expect(loadPlugins([pluginPath], tmpDir)).rejects.toThrow(
      /must export a "name" string/
    );
    await fs.rm(tmpDir, { recursive: true });
  });

  it("rejects a plugin with empty extensions", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "armillary-test-"));
    const pluginPath = path.join(tmpDir, "bad.mjs");
    await fs.writeFile(
      pluginPath,
      `export default { name: "bad", extensions: [], extract() { return ""; } };`
    );

    await expect(loadPlugins([pluginPath], tmpDir)).rejects.toThrow(
      /must export an "extensions" array/
    );
    await fs.rm(tmpDir, { recursive: true });
  });

  it("rejects a plugin with extensions missing dot prefix", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "armillary-test-"));
    const pluginPath = path.join(tmpDir, "bad.mjs");
    await fs.writeFile(
      pluginPath,
      `export default { name: "bad", extensions: ["vue"], extract() { return ""; } };`
    );

    await expect(loadPlugins([pluginPath], tmpDir)).rejects.toThrow(
      /must export an "extensions" array/
    );
    await fs.rm(tmpDir, { recursive: true });
  });

  it("rejects a plugin missing both extract and extractSymbols", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "armillary-test-"));
    const pluginPath = path.join(tmpDir, "bad.mjs");
    await fs.writeFile(
      pluginPath,
      `export default { name: "bad", extensions: [".x"] };`
    );

    await expect(loadPlugins([pluginPath], tmpDir)).rejects.toThrow(
      /must implement either "extract" or "extractSymbols"/
    );
    await fs.rm(tmpDir, { recursive: true });
  });

  it("throws when plugin module cannot be found", async () => {
    await expect(
      loadPlugins(["nonexistent-plugin-xyz-12345"], "/tmp")
    ).rejects.toThrow(/Failed to load plugin/);
  });

  it("rejects relative paths that traverse outside project root", async () => {
    await expect(
      loadPlugins(["../../etc/malicious.mjs"], "/home/user/project")
    ).rejects.toThrow(/resolves outside the project root/);
  });
});

// ── findPluginFiles ──────────────────────────────────────────────────

describe("findPluginFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "armillary-find-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it("finds files matching extensions", async () => {
    await fs.writeFile(path.join(tmpDir, "App.vue"), "<template></template>");
    await fs.writeFile(path.join(tmpDir, "main.ts"), "export const x = 1;");
    await fs.writeFile(path.join(tmpDir, "style.css"), "body {}");

    const files = await findPluginFiles(tmpDir, [".vue"]);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("App.vue");
  });

  it("searches subdirectories", async () => {
    const sub = path.join(tmpDir, "components");
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, "Button.vue"), "<template></template>");

    const files = await findPluginFiles(tmpDir, [".vue"]);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("Button.vue");
  });

  it("excludes node_modules", async () => {
    const nm = path.join(tmpDir, "node_modules", "pkg");
    await fs.mkdir(nm, { recursive: true });
    await fs.writeFile(path.join(nm, "Comp.vue"), "<template></template>");

    const files = await findPluginFiles(tmpDir, [".vue"]);
    expect(files).toHaveLength(0);
  });

  it("handles multiple extensions", async () => {
    await fs.writeFile(path.join(tmpDir, "App.vue"), "");
    await fs.writeFile(path.join(tmpDir, "App.svelte"), "");
    await fs.writeFile(path.join(tmpDir, "main.ts"), "");

    const files = await findPluginFiles(tmpDir, [".vue", ".svelte"]);
    expect(files).toHaveLength(2);
  });

  it("is case-insensitive on extension matching", async () => {
    await fs.writeFile(path.join(tmpDir, "App.VUE"), "");

    const files = await findPluginFiles(tmpDir, [".vue"]);
    expect(files).toHaveLength(1);
  });

  it("returns sorted results", async () => {
    await fs.writeFile(path.join(tmpDir, "Zebra.vue"), "");
    await fs.writeFile(path.join(tmpDir, "Alpha.vue"), "");

    const files = await findPluginFiles(tmpDir, [".vue"]);
    expect(files[0]).toContain("Alpha.vue");
    expect(files[1]).toContain("Zebra.vue");
  });
});

// ── findAllPluginFiles ───────────────────────────────────────────────

describe("findAllPluginFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "armillary-findall-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  function fakePlugin(name: string, extensions: string[]): ArmillaryPlugin {
    return {
      name,
      extensions,
      extractSymbols: () => [],
    };
  }

  it("returns one bucket per plugin with matching files", async () => {
    await fs.writeFile(path.join(tmpDir, "App.vue"), "");
    await fs.writeFile(path.join(tmpDir, "main.ts"), "");

    const plugins = [fakePlugin("vue-plugin", [".vue"])];
    const buckets = await findAllPluginFiles(tmpDir, plugins);

    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toHaveLength(1);
    expect(buckets[0][0]).toContain("App.vue");
  });

  it("separates files into correct buckets for multiple plugins", async () => {
    await fs.writeFile(path.join(tmpDir, "App.vue"), "");
    await fs.writeFile(path.join(tmpDir, "Widget.svelte"), "");
    await fs.writeFile(path.join(tmpDir, "main.ts"), "");

    const plugins = [
      fakePlugin("vue-plugin", [".vue"]),
      fakePlugin("svelte-plugin", [".svelte"]),
    ];
    const buckets = await findAllPluginFiles(tmpDir, plugins);

    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toHaveLength(1);
    expect(buckets[0][0]).toContain("App.vue");
    expect(buckets[1]).toHaveLength(1);
    expect(buckets[1][0]).toContain("Widget.svelte");
  });

  it("files appear in multiple buckets when plugins share an extension", async () => {
    await fs.writeFile(path.join(tmpDir, "Component.vue"), "");

    const plugins = [
      fakePlugin("plugin-a", [".vue"]),
      fakePlugin("plugin-b", [".vue"]),
    ];
    const buckets = await findAllPluginFiles(tmpDir, plugins);

    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toHaveLength(1);
    expect(buckets[0][0]).toContain("Component.vue");
    expect(buckets[1]).toHaveLength(1);
    expect(buckets[1][0]).toContain("Component.vue");
  });

  it("returns empty buckets when no plugins are provided", async () => {
    await fs.writeFile(path.join(tmpDir, "App.vue"), "");

    const buckets = await findAllPluginFiles(tmpDir, []);
    expect(buckets).toEqual([]);
  });

  it("returns empty buckets when no files match any plugin", async () => {
    await fs.writeFile(path.join(tmpDir, "main.ts"), "");
    await fs.writeFile(path.join(tmpDir, "style.css"), "");

    const plugins = [fakePlugin("vue-plugin", [".vue"])];
    const buckets = await findAllPluginFiles(tmpDir, plugins);

    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toEqual([]);
  });

  it("sorts files within each bucket for determinism", async () => {
    await fs.writeFile(path.join(tmpDir, "Zebra.vue"), "");
    await fs.writeFile(path.join(tmpDir, "Alpha.vue"), "");

    const plugins = [fakePlugin("vue-plugin", [".vue"])];
    const buckets = await findAllPluginFiles(tmpDir, plugins);

    expect(buckets[0][0]).toContain("Alpha.vue");
    expect(buckets[0][1]).toContain("Zebra.vue");
  });

  it("traverses subdirectories", async () => {
    const sub = path.join(tmpDir, "components");
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, "Button.vue"), "");

    const plugins = [fakePlugin("vue-plugin", [".vue"])];
    const buckets = await findAllPluginFiles(tmpDir, plugins);

    expect(buckets[0]).toHaveLength(1);
    expect(buckets[0][0]).toContain("Button.vue");
  });

  it("excludes node_modules by default", async () => {
    const nm = path.join(tmpDir, "node_modules", "pkg");
    await fs.mkdir(nm, { recursive: true });
    await fs.writeFile(path.join(nm, "Comp.vue"), "");

    const plugins = [fakePlugin("vue-plugin", [".vue"])];
    const buckets = await findAllPluginFiles(tmpDir, plugins);

    expect(buckets[0]).toEqual([]);
  });

  it("handles a plugin claiming multiple extensions", async () => {
    await fs.writeFile(path.join(tmpDir, "file.jsx"), "");
    await fs.writeFile(path.join(tmpDir, "file.tsx"), "");
    await fs.writeFile(path.join(tmpDir, "file.ts"), "");

    const plugins = [fakePlugin("react-plugin", [".jsx", ".tsx"])];
    const buckets = await findAllPluginFiles(tmpDir, plugins);

    expect(buckets[0]).toHaveLength(2);
    expect(buckets[0].some((f) => f.endsWith(".jsx"))).toBe(true);
    expect(buckets[0].some((f) => f.endsWith(".tsx"))).toBe(true);
  });

  it("is case-insensitive on extension matching", async () => {
    await fs.writeFile(path.join(tmpDir, "App.VUE"), "");

    const plugins = [fakePlugin("vue-plugin", [".vue"])];
    const buckets = await findAllPluginFiles(tmpDir, plugins);

    expect(buckets[0]).toHaveLength(1);
  });
});

// ── Schema: "component" kind ─────────────────────────────────────────

describe("schema component kind", () => {
  it("accepts 'component' as a valid kind", () => {
    const result = SymbolDocSchema.safeParse({
      id: "components/App.vue#default",
      kind: "component",
      name: "App",
      filePath: "components/App.vue",
      exported: true,
    });
    expect(result.success).toBe(true);
  });

  it("still accepts existing kinds", () => {
    for (const kind of [
      "function",
      "class",
      "type",
      "const",
      "interface",
      "enum",
    ]) {
      const result = SymbolDocSchema.safeParse({
        id: `test.ts#${kind}Thing`,
        kind,
        name: `${kind}Thing`,
        filePath: "test.ts",
        exported: true,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects unknown kind", () => {
    const result = SymbolDocSchema.safeParse({
      id: "test.ts#x",
      kind: "widget",
      name: "x",
      filePath: "test.ts",
      exported: true,
    });
    expect(result.success).toBe(false);
  });
});

// ── Indexer integration with plugins ─────────────────────────────────

describe("generateDocIndex with plugins", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "armillary-idx-"));
    // Minimal tsconfig
    await fs.writeFile(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", strict: true },
        include: ["*.ts"],
      })
    );
    // A basic TS file so ts-morph has something
    await fs.writeFile(
      path.join(tmpDir, "main.ts"),
      `export function hello() { return "hi"; }\n`
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it("calls init and dispose lifecycle hooks", async () => {
    const initFn = vi.fn();
    const disposeFn = vi.fn();

    const plugin: ArmillaryPlugin = {
      name: "lifecycle-test",
      extensions: [".nope"], // no files will match
      extractSymbols: () => [],
      init: initFn,
      dispose: disposeFn,
    };

    await generateDocIndex({
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
      outputPath: path.join(tmpDir, "out.json"),
      plugins: [plugin],
    });

    expect(initFn).toHaveBeenCalledOnce();
    expect(initFn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: tmpDir,
        tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      })
    );
    expect(disposeFn).toHaveBeenCalledOnce();
  });

  it("extractSymbols path: merges plugin symbols into output", async () => {
    await fs.writeFile(
      path.join(tmpDir, "App.custom"),
      "<template>hello</template>"
    );

    const plugin: ArmillaryPlugin = {
      name: "custom-plugin",
      extensions: [".custom"],
      extractSymbols: (filePath) => {
        const name = path.basename(filePath, ".custom");
        return [
          {
            id: `${name}.custom#default`,
            kind: "component" as const,
            name,
            filePath: `${name}.custom`,
            exported: true,
            description: "A custom component",
          },
        ];
      },
    };

    const index = await generateDocIndex({
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
      outputPath: path.join(tmpDir, "out.json"),
      plugins: [plugin],
    });

    const componentSymbol = index.symbols.find((s) => s.kind === "component");
    expect(componentSymbol).toBeDefined();
    expect(componentSymbol!.name).toBe("App");
    expect(componentSymbol!.description).toBe("A custom component");

    // Also has the normal TS symbol
    const fnSymbol = index.symbols.find((s) => s.name === "hello");
    expect(fnSymbol).toBeDefined();
  });

  it("extractSymbols path: normalizes absolute filePaths to relative", async () => {
    await fs.writeFile(
      path.join(tmpDir, "Abs.custom"),
      "content"
    );

    const plugin: ArmillaryPlugin = {
      name: "abs-path-plugin",
      extensions: [".custom"],
      extractSymbols: (filePath) => {
        // Return absolute path — core should normalize it
        return [
          {
            id: `absolute#default`,
            kind: "component" as const,
            name: "Abs",
            filePath, // absolute path
            exported: true,
          },
        ];
      },
    };

    const index = await generateDocIndex({
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
      outputPath: path.join(tmpDir, "out.json"),
      plugins: [plugin],
    });

    const sym = index.symbols.find((s) => s.name === "Abs");
    expect(sym).toBeDefined();
    // filePath should be relative, not absolute
    expect(path.isAbsolute(sym!.filePath)).toBe(false);
    expect(sym!.filePath).toBe("Abs.custom");
    // id should be rewritten with the relative path
    expect(sym!.id).toBe("Abs.custom#Abs");
  });

  it("extract path: plugin returns TS code that gets indexed", async () => {
    await fs.writeFile(
      path.join(tmpDir, "utils.ext"),
      "FAKE_FORMAT: export const magicNumber = 42;"
    );

    const plugin: ArmillaryPlugin = {
      name: "extract-plugin",
      extensions: [".ext"],
      extract: (_filePath, content) => {
        // Strip the fake prefix
        return content.replace("FAKE_FORMAT: ", "");
      },
    };

    const index = await generateDocIndex({
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
      outputPath: path.join(tmpDir, "out.json"),
      plugins: [plugin],
    });

    const magicSymbol = index.symbols.find((s) => s.name === "magicNumber");
    expect(magicSymbol).toBeDefined();
    expect(magicSymbol!.kind).toBe("const");
    // filePath should reference the original file, not the virtual .ts
    expect(magicSymbol!.filePath).toBe("utils.ext");
    expect(magicSymbol!.id).toBe("utils.ext#magicNumber");
  });

  it("extract path: null return is skipped", async () => {
    await fs.writeFile(path.join(tmpDir, "empty.ext"), "");

    const plugin: ArmillaryPlugin = {
      name: "null-extract",
      extensions: [".ext"],
      extract: () => null,
    };

    const index = await generateDocIndex({
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
      outputPath: path.join(tmpDir, "out.json"),
      plugins: [plugin],
    });

    // Only the main.ts symbol
    expect(index.symbols).toHaveLength(1);
    expect(index.symbols[0].name).toBe("hello");
  });

  it("dispose is called even if extraction throws", async () => {
    const disposeFn = vi.fn();
    await fs.writeFile(path.join(tmpDir, "bad.boom"), "content");

    const plugin: ArmillaryPlugin = {
      name: "error-plugin",
      extensions: [".boom"],
      extractSymbols: () => {
        throw new Error("boom!");
      },
      dispose: disposeFn,
    };

    await expect(
      generateDocIndex({
        tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
        projectRoot: tmpDir,
        outputPath: path.join(tmpDir, "out.json"),
        plugins: [plugin],
      })
    ).rejects.toThrow("boom!");

    expect(disposeFn).toHaveBeenCalledOnce();
  });

  it("only disposes successfully initialized plugins when a later init throws", async () => {
    const dispose1 = vi.fn();
    const dispose2 = vi.fn();

    const plugin1: ArmillaryPlugin = {
      name: "ok-plugin",
      extensions: [".nope"],
      extractSymbols: () => [],
      init: () => {},
      dispose: dispose1,
    };

    const plugin2: ArmillaryPlugin = {
      name: "bad-init",
      extensions: [".nope"],
      extractSymbols: () => [],
      init: () => {
        throw new Error("init failed");
      },
      dispose: dispose2,
    };

    await expect(
      generateDocIndex({
        tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
        projectRoot: tmpDir,
        outputPath: path.join(tmpDir, "out.json"),
        plugins: [plugin1, plugin2],
      })
    ).rejects.toThrow("init failed");

    // plugin1 initialized successfully, so it should be disposed
    expect(dispose1).toHaveBeenCalledOnce();
    // plugin2 never initialized, so it should NOT be disposed
    expect(dispose2).not.toHaveBeenCalled();
  });

  it("symbols are sorted by id for determinism", async () => {
    await fs.writeFile(path.join(tmpDir, "z.custom"), "");
    await fs.writeFile(path.join(tmpDir, "a.custom"), "");

    const plugin: ArmillaryPlugin = {
      name: "sort-test",
      extensions: [".custom"],
      extractSymbols: (filePath) => {
        const name = path.basename(filePath, ".custom");
        return [
          {
            id: `${name}.custom#default`,
            kind: "component" as const,
            name,
            filePath: `${name}.custom`,
            exported: true,
          },
        ];
      },
    };

    const index = await generateDocIndex({
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
      outputPath: path.join(tmpDir, "out.json"),
      plugins: [plugin],
    });

    const ids = index.symbols.map((s) => s.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});

// ── Watcher: plugin extensions trigger rebuilds ──────────────────────

describe("watchAndRegenerate with plugin extensions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "armillary-watch-plugin-"));

    await fs.writeFile(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", strict: true },
        include: ["src"],
      })
    );

    await fs.mkdir(path.join(tmpDir, "src"));
    await fs.writeFile(
      path.join(tmpDir, "src", "main.ts"),
      `export function hello() { return "hi"; }\n`
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rebuilds when a plugin-extension file is added", async () => {
    const onBuildComplete = vi.fn();

    const plugin: ArmillaryPlugin = {
      name: "custom-watcher",
      extensions: [".custom"],
      extractSymbols: (filePath) => {
        const name = path.basename(filePath, ".custom");
        const rel = path.relative(tmpDir, filePath).split(path.sep).join("/");
        return [
          {
            id: `${rel}#default`,
            kind: "component" as const,
            name,
            filePath: rel,
            exported: true,
          },
        ];
      },
    };

    const handle = await watchAndRegenerate({
      tsConfigFilePath: path.join(tmpDir, "tsconfig.json"),
      projectRoot: tmpDir,
      watchPaths: [path.join(tmpDir, "src")],
      debounceMs: 100,
      plugins: [plugin],
      onBuildComplete,
    });

    try {
      // Initial build done
      expect(onBuildComplete).toHaveBeenCalledTimes(1);
      onBuildComplete.mockClear();

      // Add a .custom file — should trigger a rebuild
      await fs.writeFile(
        path.join(tmpDir, "src", "Widget.custom"),
        "<custom>content</custom>"
      );

      await vi.waitFor(
        () => {
          expect(onBuildComplete).toHaveBeenCalled();
        },
        { timeout: 10_000, interval: 100 }
      );
    } finally {
      await handle.close();
    }
  }, 15_000);
});
