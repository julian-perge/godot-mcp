Source issue: [#1 Replace the deprecated Server class with McpServer in src/index.ts](https://github.com/julian-perge/godot-mcp/issues/1)

# Spec: Move GodotServer to McpServer with Zod tool schemas

## Objective

`src/index.ts` builds its MCP server with `Server` from `@modelcontextprotocol/sdk/server/index.js`. SDK 1.32.2 marks that class `@deprecated`, and the editor shows `TS6385`. This change moves `GodotServer` to `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`. Each of the 20 tools is registered with `McpServer.registerTool` and a Zod input schema. The two raw handlers for `tools/list` and `tools/call` go away.

The users are MCP clients. Today the only one is the set of Claude Code sessions in `~/code/urchin`.

### Decision: Zod schemas, no snake_case aliases

[ADR-0001](../docs/adr/0001-zod-tool-schemas-without-snake-case-aliases.md) records this decision. The user chose it on 2026-11-11 over two other options: keep the raw handlers through `McpServer.server`, or rewrite in Zod and keep the aliases.

- Today `normalizeParameters` accepts snake_case aliases for top-level tool arguments, for example `project_path` for `projectPath`. `tools/list` advertises only the camelCase names.
- Evidence: the urchin Claude Code transcripts in `~/.claude/projects/*urchin*` (15 files) hold 511 `mcp__godot__*` calls. Every top-level argument key in them is camelCase. No call uses an alias.
- A Zod object drops keys that it does not declare. After this change, a call with `project_path` and no `projectPath` fails Zod validation because the required `projectPath` is missing.
- This is a breaking change for a client that sends aliases. No known client does.

Nested keys that the schemas declare in snake_case stay in snake_case. Examples are `duration_ms`, `from_x` and `delay_ms` in the `simulate_input` commands. They are part of the schema, not aliases.

### Behavior that changes

The issue's acceptance criteria require identical `tools/list` output and identical results. Zod and `McpServer` make that impossible in these places. This spec replaces those two criteria.

1. **Input schemas in `tools/list`.** The SDK converts each Zod schema with `z.toJSONSchema(schema, { io: 'input' })`. The output adds a `$schema` key. Key order and some keyword shapes can differ. The meaning must stay the same: the same property names, types, enums, `required` lists, array item schemas and descriptions.
2. **Invalid input.** The SDK validates arguments before the tool handler runs. An argument with the wrong type or a missing required argument returns an `isError` result with text that starts with `Input validation error: Invalid arguments for tool <name>:`. Today the handler returns its own message, for example `embedded must be true or false` or `Project path is required`.
3. **snake_case aliases.** These are not accepted, as the decision above describes.
4. **Unknown tool name.** Today the server throws a JSON-RPC `MethodNotFound` error. `McpServer` returns an `isError` tool result instead (`Tool <name> not found`).
5. **Capabilities.** `McpServer` declares `tools: { listChanged: true }`. Today the server declares `tools: {}`.

For every input that passes the new schema, each tool returns the same result as before.

## Tech Stack

- TypeScript, ES modules, Bun for build and tests. See [AGENTS.md](../AGENTS.md).
- `@modelcontextprotocol/sdk` 1.32.2 (`McpServer`).
- `zod` 4. Today it comes only through the SDK (4.6.7 in `bun.lock`). This change adds it to `dependencies` in `package.json` with the range `^4.0.0`, so that `src/index.ts` can import it directly.

## Commands

See [AGENTS.md](../AGENTS.md). The main ones:

- Build: `bun run build`
- Test: `bun run test` (builds, then runs `bun test tests/`)
- Inspect: `bun run inspector`
- Type check: `bunx tsc --noEmit`

## Project Structure

See [AGENTS.md](../AGENTS.md). This change touches:

- `src/index.ts`: server construction, tool registration, handler entry points, `normalizeParameters`, `parameterMappings`.
- `package.json`, `bun.lock`: the `zod` dependency.
- `tests/run_scene.test.mjs`: assertions on validation messages that now come from Zod.
- A new test file for the tool list (see Testing Strategy).

Keep the Zod schemas in `src/index.ts`, next to their `registerTool` calls. Do not add a schema module.

## Code Style

See [AGENTS.md](../AGENTS.md). The target shape of one registration:

```ts
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

this.server.registerTool(
  'get_project_info',
  {
    description: 'Retrieve metadata about a Godot project',
    inputSchema: {
      projectPath: z.string().describe('Path to the Godot project directory'),
    },
  },
  (args) => this.handleGetProjectInfo(args),
);
```

Rules:

- Copy each description string from the current JSON Schema literal without changes, for tools and for properties.
- Do not use `.default()`. A default changes the JSON Schema and the values the handler receives. `tests/run_scene.test.mjs` asserts that `timeoutMs` has no `default`.
- Use `z.object` (the default strip mode). Do not use `.strict()`, so that a client which sends an extra key still works.
- A JSON Schema `enum` becomes `z.enum([...])`. An optional property becomes `.optional()`.
- A tool with no arguments has no `inputSchema`.

## Implementation notes

- Replace `new Server(...)` with `new McpServer({ name: 'godot-mcp', version: '0.1.0' })`. Remove the `Server`, `ListToolsRequestSchema` and `CallToolRequestSchema` imports.
- `this.server.onerror` becomes `this.server.server.onerror`. `connect` and `close` exist on `McpServer`.
- Remove `normalizeParameters` and its calls in the handlers.
- `convertCamelToSnakeCase` converts parameters for `godot_operations.gd`. Keep that behavior. It reads `reverseParameterMappings`, which is built from `parameterMappings`. Every entry in `parameterMappings` gives the same result as the regex fallback in `convertCamelToSnakeCase`. So `parameterMappings` and `reverseParameterMappings` can be removed, and the regex does the conversion. Confirm this entry by entry before removing them.
- A handler check for a required argument that Zod now guarantees is unreachable. Remove it. Keep checks that Zod does not do, such as `validatePath` and file existence checks.

## Testing Strategy

- Framework: `bun test` with `node:test` and `node:assert`, MCP client over stdio against `build/index.js`, as in the current tests in `tests/`.
- Add `tests/tool-list.test.mjs`. It calls `tools/list` and checks, for all 20 tools:
  - the tool names match the current list, and
  - each tool's description, property names, property types, enums and `required` list match a fixture.
  The fixture is `tests/fixtures/tool-list.json`. Generate it from the build on `main` before the change, with the `$schema` key removed. The test removes `$schema` from the new output and compares the normalized schemas.
- Change the assertion in `tests/run_scene.test.mjs` for `embedded: 'yes'` to match the Zod validation error.
- Add one test that a call with `project_path` and no `projectPath` returns an `isError` result. This records the decision.
- Tests that need Godot skip when `GODOT_PATH` is not set. The tool list test does not need Godot.

## Boundaries

- Always: run `bun run test` before each commit. Keep descriptions identical. Keep camelCase top-level argument names.
- Ask first: any change to a tool name, a description, a property name or a `required` list. Any new dependency other than `zod`. Any change to `godot_operations.gd` or `mcp_harness.gd`.
- Never: add `.default()` to a schema. Use `McpServer.server.setRequestHandler` for `tools/list` or `tools/call`. Change tool behavior for valid input.

## Success Criteria

- [ ] `src/index.ts` does not import `Server` from `server/index.js`. The editor shows no `TS6385` in `src/index.ts`.
- [ ] All 20 tools are registered with `registerTool`. No `setRequestHandler` call remains in `src/index.ts`.
- [ ] `tools/list` returns the same 20 names and descriptions. Each input schema has the same properties, types, enums, item schemas and `required` list as before. `tests/tool-list.test.mjs` checks this.
- [ ] For valid input, every tool returns the same result as before.
- [ ] Invalid input returns the SDK's `Input validation error` result. A snake_case alias such as `project_path` is not accepted.
- [ ] `zod` is in `dependencies` in `package.json`.
- [ ] `bun run test` passes.
- [ ] The PR attaches the `tools/list` diff between `main` and the branch (`bun run inspector`, or the fixture test output) and lists the five behavior changes above.

## Open Questions

None. This spec overrides the acceptance criteria in issue #1, and the issue body points here. [ADR-0001](../docs/adr/0001-zod-tool-schemas-without-snake-case-aliases.md) records the decision.
