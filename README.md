# project-mcp-docs

Index your TypeScript project so AI coding assistants can discover and reuse your existing code. Extracts every exported function, class, type, interface, enum, and constant — complete with signatures, JSDoc comments, and parameter details — and serves them through the Model Context Protocol (MCP) for tools like Claude Code, Cursor, and Windsurf.

## Features

- **Symbol extraction** — functions, classes, types, interfaces, enums, and constants from the AST
- **Full signatures** — complete type signatures extracted via ts-morph
- **JSDoc parsing** — `@param`, `@returns`, descriptions, and custom tags
- **CLI tools** — `build` generates the index, `watch` regenerates on save
- **MCP server** — `docs.list`, `docs.get`, `docs.search` tools for any MCP client
- **Deterministic output** — sorted, Zod-validated, reproducible JSON

## Why?

AI coding assistants frequently recreate utilities that already exist in your codebase because they can't see what's there. This tool gives them a searchable index of your exported symbols — functions, classes, types, interfaces — so they can find and reuse what's already written instead of writing it again.

## Quick Start

Install as a dev dependency:

```sh
pnpm add -D project-mcp-docs
```

Generate the documentation index:

```sh
npx mcp-docs build
```

Start the MCP server:

```sh
npx mcp-docs-server
```

Connect your AI coding assistant. For Claude Code (`.claude/settings.json`), Cursor, or any MCP client:

```json
{
  "mcpServers": {
    "project-docs": {
      "command": "npx",
      "args": ["mcp-docs-server"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

## CLI Commands

### `mcp-docs build`

Reads `tsconfig.json` from the current working directory, extracts all exported symbols, and writes a documentation index to `.mcp-docs/index.json`. Prints a summary of extracted symbols to stdout.

### `mcp-docs watch`

Watches for `.ts` and `.tsx` file changes and regenerates the index automatically. Uses 300ms debounce. Ignores `node_modules`, `dist`, `.d.ts` files, and the `.mcp-docs` output directory.

## MCP Tools

The MCP server lets AI coding assistants query your codebase:

| Tool | Description | Parameters |
|------|-------------|------------|
| `docs.list` | List all documented symbols (id, kind, name) | None |
| `docs.get` | Get full documentation for a symbol | `id` (string, required) |
| `docs.search` | Search symbols by name or description | `q` (string, required), `limit` (number, optional, default: 10) |

## Programmatic API

```typescript
import {
  generateDocIndex,
  watchAndRegenerate,
  loadDocIndex,
  listSymbols,
  getSymbol,
  searchSymbols,
} from "project-mcp-docs";

// Generate documentation
const index = await generateDocIndex({
  tsConfigFilePath: "./tsconfig.json",
  projectRoot: process.cwd(),
});

// Load and query
const loaded = await loadDocIndex(process.cwd());
const symbols = listSymbols(loaded);
const result = getSymbol(loaded, "src/foo.ts#bar");
const matches = searchSymbols(loaded, "generate", 5);
```

See the [full manual](https://philllt.github.io/project-mcp-docs/manual.html) for complete API documentation including `watchAndRegenerate`, `createBuildController`, Zod schemas, and the schema reference.

## Documentation

Full documentation is available at: https://philllt.github.io/project-mcp-docs/

- [Home](https://philllt.github.io/project-mcp-docs/) — overview and quick start
- [Manual](https://philllt.github.io/project-mcp-docs/manual.html) — CLI, MCP server, API, and schema reference

## Development

### Prerequisites

- Node.js >= 18
- pnpm

### Setup

```sh
git clone https://github.com/philllt/project-mcp-docs.git
cd project-mcp-docs
pnpm install
```

### Build

```sh
pnpm build
```

### Test

```sh
pnpm test
```

## Contributing

1. Fork the repo and create a feature branch
2. Write tests for new functionality
3. Run `pnpm test` and ensure all tests pass
4. Follow existing code style (strict TypeScript, ESM)
5. Keep commits focused and descriptive
6. Open a PR with a clear description of what changed and why

## License

ISC
