# Spec: harness-node-tree, V1

Source issue: [#12](https://github.com/julian-perge/godot-mcp/issues/12). The first consumer is [julian-perge/urchin#489](https://github.com/julian-perge/urchin/issues/489), and its spec depends on this one. Nothing in this spec depends on urchin.

Commands, project structure and code style are in [AGENTS.md](../AGENTS.md). Top-level tool arguments are camelCase, as [ADR-0001](../docs/adr/0001-zod-tool-schemas-without-snake-case-aliases.md) says.

## Objective

`src/scripts/mcp_harness.gd` gets two read-only commands, `node` and `tree`, and sets the window title from an env var. The server gets two tools, `inspect_node` and `inspect_tree`, that send these commands.

With these, an agent can find a control by its name, read where it is and click it, instead of guessing coordinates from a screenshot. This works for any Godot 4 project. The commands read only engine classes (`Node`, `CanvasItem`, `Control`, `Node2D`) and assume no scene, node name or autoload.

The two ways in reach different games:

- The MCP tools reach only the game that the server started with `run_project` or `run_scene`.
- A launcher of its own, which sets `GODOT_MCP_HARNESS_PORT` and `GODOT_MCP_HARNESS_TOKEN` and passes the harness with `-s`, sends the commands over TCP itself. urchin's verify-urchin skill works this way. Today it writes a wrapper script around the harness to add these three things. After this change it writes no wrapper.

## Harness commands

Both commands read the scene tree and change nothing. They go through `_run_command` like the input commands, so one request can mix them with clicks and screenshots.

### Node lookup

`path` resolves in this order. The `node` and `tree` commands both use it.

1. An empty or missing `path` is the current scene.
2. A `path` that starts with `/` is an absolute path from the root.
3. Otherwise the path is relative to the current scene, then relative to the root.
4. A bare name with no `/` that steps 1 to 3 did not find is looked up with `root.find_children(name, "", true, false)`. The first match that is visible in the tree wins. When no match is visible, the first match wins.

Step 4 prefers a visible match because a scene can hold several nodes with the same name, such as a close button in each of several panels, and only one of them is on screen. urchin's main menu has this case, with two `CloseButton` nodes.

### `node`

Request: `{"type": "node", "path": "<path>", "props": ["<name>", ...]}`. `props` is optional.

Result:

| Key | When | Value |
| --- | --- | --- |
| `path` | always | `str(node.get_path())` |
| `class` | always | `node.get_class()` |
| `visible` | CanvasItem | `is_visible_in_tree()` |
| `rect` | Control | `[x, y, w, h]` of `get_global_rect()` |
| `center` | Control | `[x, y]` of the rect's center |
| `position` | Node2D | `[x, y]` of `global_position` |
| `text` | node has a `text` property | `str(text)` |
| `props` | `props` was given | a dictionary of each name to `var_to_str(node.get(name))` |

Rects and positions are in the same viewport coordinates as `click` and `screenshot`.

Errors:

- No node: `no node <path> in the scene <scene_file_path>`, or `in no scene` when there is no current scene.
- `props` that is not a list of strings: `props must be a list of property names`.

### `tree`

Request: `{"type": "tree", "path": "<path>", "depth": 3, "include_hidden": false}`. All three keys are optional, and the defaults are shown.

The command walks from the resolved node down to `depth` levels below it. A CanvasItem that is not visible in the tree is left out with its children, unless `include_hidden` is true.

Result: `{"scene": <scene_file_path or "">, "root": <current scene path or "/root">, "nodes": [...]}`. Each entry has the `node` result keys except `props`, plus `depth`, the level below the start node.

Errors:

- No node: the same message as `node`.
- `depth` that is not a whole number of 0 or more: `depth must be a whole number, 0 or more`.
- `include_hidden` that is not a boolean: `include_hidden must be true or false`.

### Window title

When `GODOT_MCP_HARNESS_TITLE` is set and not empty, `_initialize` calls `DisplayServer.window_set_title` with it. When it is unset, the title stays the project's own.

## MCP tools

Both tools use `requestHarness` with a 15 s timeout. Each one answers with one text item that holds the harness result as JSON. A harness error is an `isError` result with the error text, as in `handleSimulateInput`.

| Tool | Arguments | Sends |
| --- | --- | --- |
| `inspect_node` | `path` (string, required), `props` (string list, optional) | one `node` command |
| `inspect_tree` | `path` (string, optional), `depth` (integer 0 to 20, optional, default 3), `includeHidden` (boolean, optional, default false) | one `tree` command |

The depth cap of 20 keeps one answer from holding the whole tree of a big scene. The harness command takes any depth.

The tool descriptions say that both tools need a game started by `run_project` or `run_scene` with the harness on, and that positions are in viewport coordinates.

## Project structure

- `src/scripts/mcp_harness.gd`: the commands and the title.
- `src/index.ts`: the two schemas, the two `registerTool` calls and their handlers.
- `tests/fixtures/tool-list.json`: the two new tools.
- `tests/fixtures/run-scene-project/`: a scene with a visible Control, a hidden Control and a Node2D, if `smoke_test.tscn` lacks them.
- `README.md`: one section, "Inspect Nodes", after "Simulate Input". It documents both tools and the two TCP commands, for a launcher of its own. Also the `GODOT_MCP_HARNESS_TITLE` row in "Environment Variables".

## Testing strategy

- `bun run test` runs everything. The tool-list test checks the fixture.
- `tests/input-validation.test.mjs` gets a case for each new tool: a `depth` of 21 and a `props` that is not a list fail validation.
- `tests/run_scene.test.mjs` runs only with `GODOT_PATH` set. Add a case that runs the fixture scene, then checks:
  - `inspect_tree` lists the visible Control and leaves out the hidden one, and `includeHidden: true` lists both.
  - `inspect_node` on the visible Control's bare name returns its `rect` and `center`, and `props: ["name"]` returns the name.
  - `inspect_node` on a missing name is an error that names the path.
- Prove each check can fail: break the visibility filter and the bare-name lookup in turn, and watch the matching assertion go red.

## Boundaries

- Always: run `bun run test` with `GODOT_PATH` set before each commit, so the integration test runs.
- Ask first: any change to the commands that exist now, or to the request and answer framing.
- Never: write to the scene tree from `node` or `tree`. Never name or assume a project, scene, node or autoload in the harness, the tools or their descriptions. A project's own names go only in test fixtures.

## Success criteria

- A game started with `-s src/scripts/mcp_harness.gd` answers `node` and `tree` over TCP, with no wrapper script.
- `GODOT_MCP_HARNESS_TITLE=x` gives a window titled `x`.
- `inspect_node` and `inspect_tree` are in `tools/list`, and the integration test above passes.
- `bun run test` passes.

## Out of scope (deferred)

- `run_project` and `run_scene` setting a title of their own. A launcher of its own sets the env var.
- Commands that write to nodes or call methods. The harness stays read-only apart from input.

## Open questions

- None. The `props` dictionary and the `include_hidden` key are guesses in the decision comment on #12. The urchin wrapper that these commands replace put props at the top level and named the key `all`.
