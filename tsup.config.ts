import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: ["src/server.ts"],
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: ["src/plugins/react.ts"],
    format: ["esm"],
    dts: true,
    outDir: "dist/plugins",
  },
]);
