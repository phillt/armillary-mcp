<p align="center">
  <img src="docs/armillary-mcp-logo.svg" alt="armillary-mcp logo" width="90">
</p>

# armillary-mcp

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

### 1. Install

```sh
npm install --save-dev armillary-mcp
```

Or with pnpm:

```sh
pnpm add -D armillary-mcp
```

### 2. Build the documentation index

```sh
npx armillary-mcp build
```

### 3. Add the prompt to your agent

Add code-reuse instructions so your agent checks the documentation index before creating new code. For **Claude Code**, add to your project's `CLAUDE.md`:

```markdown
## Code Reuse

Before creating new services, utilities, or helpers, use the armillary-mcp tools to check if similar functionality already exists:

1. Use `docs.search` with relevant keywords to find existing implementations
2. Use `docs.get` to review the full signature and documentation of potential matches
3. If a suitable symbol exists, reuse or extend it instead of creating a new one
4. If nothing suitable exists, proceed with creating a new implementation

This prevents duplicate services and keeps the codebase consistent.
```

For Cursor, Windsurf, VS Code, Zed, Cline, and other agents, see the [manual](https://philllt.github.io/armillary-mcp/manual.html#quick-setup) for agent-specific prompt configuration.

### 4. Add the MCP server to your agent

For **Claude Code**, register the server with the CLI:

```sh
claude mcp add --transport stdio armillary-mcp -- npx armillary-mcp-server
```

For **Cursor**, **Windsurf**, and other MCP clients, add to your client's config file (see the [manual](https://philllt.github.io/armillary-mcp/manual.html#quick-setup) for agent-specific config paths):

```json
{
  "mcpServers": {
    "armillary": {
      "command": "npx",
      "args": ["armillary-mcp-server"]
    }
  }
}
```

### 5. Watch for changes

```sh
npx armillary-mcp watch
```

> [!TIP]
> Add the watch command to your dev script (e.g. alongside your dev server) so the index always stays current while you work.

## CLI Commands

### `armillary-mcp build`

Reads `tsconfig.json` from the current working directory, extracts all exported symbols, and writes a documentation index to `.armillary-mcp-docs/index.json`. Prints a summary of extracted symbols to stdout.

### `armillary-mcp watch`

Watches for `.ts` and `.tsx` file changes and regenerates the index automatically. Uses 300ms debounce. Ignores `node_modules`, `dist`, `.d.ts` files, and the `.armillary-mcp-docs` output directory.

## MCP Tools

The MCP server lets AI coding assistants query your codebase:

| Tool | Description | Parameters |
|------|-------------|------------|
| `docs.list` | List documented symbols with optional filtering and pagination | `kind`, `pathPrefix`, `cursor`, `limit` (all optional) |
| `docs.get` | Get full documentation for a symbol | `id` (string, required) |
| `docs.search` | Search symbols by name or description | `q` (string, required), `kind` (string, optional), `limit` (number, optional) |

## Programmatic API

```typescript
import {
  generateDocIndex,
  watchAndRegenerate,
  loadDocIndex,
  listSymbols,
  getSymbol,
  searchSymbols,
} from "armillary-mcp";

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

See the [full manual](https://philllt.github.io/armillary-mcp/manual.html) for complete API documentation including `watchAndRegenerate`, `createBuildController`, Zod schemas, and the schema reference.

## Documentation

Full documentation is available at: https://philllt.github.io/armillary-mcp/

- [Home](https://philllt.github.io/armillary-mcp/) — overview and quick start
- [Manual](https://philllt.github.io/armillary-mcp/manual.html) — CLI, MCP server, API, and schema reference

## Development

### Prerequisites

- Node.js >= 18
- pnpm

### Setup

```sh
git clone https://github.com/philllt/armillary-mcp.git
cd armillary-mcp
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
