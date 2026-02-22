# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Armillary MCP — indexes TypeScript projects so AI coding assistants can discover and reuse existing code via the Model Context Protocol.

## Local MCP Server Setup

To use Armillary MCP as a local stdio server in Claude Code, first build and generate the doc index, then register the server:

```bash
# Build the project
pnpm build

# Generate the doc index for the target project
pnpm generate

# Add the server to Claude Code (local scope, current project only)
claude mcp add --transport stdio armillary-mcp -- node /absolute/path/to/project-mcp-docs/dist/server.js
```

The server reads `.armillary-mcp-docs/` from the working directory, so make sure the command runs from a directory that contains a generated doc index.

For development, you can use `tsx` directly instead of the built output:

```bash
claude mcp add --transport stdio armillary-mcp -- npx tsx /absolute/path/to/project-mcp-docs/src/server.ts
```

To verify the server is connected, run `/mcp` inside Claude Code.
