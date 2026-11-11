# ADR-0001: Zod tool schemas through McpServer, without snake_case aliases

## Status

Accepted

## Date

2026-11-11

## Context

`src/index.ts` builds its MCP server with `Server` from `@modelcontextprotocol/sdk/server/index.js`. SDK 1.32.2 marks that class `@deprecated` and points to `McpServer` ([#1](https://github.com/julian-perge/godot-mcp/issues/1)).

The server defines 20 tools as JSON Schema literals behind two raw handlers, one for `tools/list` and one for `tools/call`. `McpServer.registerTool` takes only Zod schemas. It validates the arguments before the tool handler runs, and it converts the Zod schema to JSON Schema for `tools/list`.

The handlers also accept snake_case aliases for top-level arguments, for example `project_path` for `projectPath`. `normalizeParameters` maps them. `tools/list` advertises only the camelCase names.

The only known client is the set of Claude Code sessions in `~/code/urchin`. Their transcripts hold 511 calls to this server. Every top-level argument key in them is camelCase.

## Decision

Register every tool with `McpServer.registerTool` and a Zod input schema. Remove the raw handlers. Remove the snake_case aliases and `normalizeParameters`.

Top-level argument names are camelCase only. Nested keys that a schema declares in snake_case, such as `duration_ms` in `simulate_input` commands, stay as they are.

## Alternatives Considered

### Keep the raw handlers through `McpServer.server`

- Pros: `tools/list` output and every tool result stay identical. Smallest diff.
- Cons: The tools do not use `registerTool`. The server keeps hand-written JSON Schema and hand-written argument checks.
- Rejected: It only moves the deprecated API behind a property. It does not adopt the high-level API.

### Zod schemas that keep the aliases

- Pros: A client that sends snake_case keys keeps working.
- Cons: Each schema needs a loose object and an optional alias for each argument, and a required argument can no longer be marked required. The aliases also show up in `tools/list`.
- Rejected: No known client sends an alias, so the extra schema code buys nothing.

## Consequences

- A client that sends a snake_case alias in place of the camelCase name gets an `Input validation error` result. This is a breaking change for such a client.
- Invalid input returns the SDK's `Input validation error` result instead of the handler's own message.
- `tools/list` schemas come from `z.toJSONSchema` and gain a `$schema` key. Their properties, types, enums and `required` lists stay the same.
- An unknown tool name returns an `isError` result instead of a JSON-RPC `MethodNotFound` error.
- `zod` becomes a direct dependency.
- [spec/1-mcpserver.md](../../spec/1-mcpserver.md) lists the full set of behavior changes and the tests.
