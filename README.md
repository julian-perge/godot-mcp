# Godot MCP

[![Github-sponsors](https://img.shields.io/badge/sponsor-30363D?style=for-the-badge&logo=GitHub-Sponsors&logoColor=#EA4AAA)](https://github.com/sponsors/Coding-Solo)

[![](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Made with Godot](https://img.shields.io/badge/Made%20with-Godot-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white 'Node.js')](https://nodejs.org/en/download/)
[![](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white 'TypeScript')](https://www.typescriptlang.org/)

[![](https://img.shields.io/github/last-commit/Coding-Solo/godot-mcp 'Last Commit')](https://github.com/Coding-Solo/godot-mcp/commits/main)
[![](https://img.shields.io/github/stars/Coding-Solo/godot-mcp 'Stars')](https://github.com/Coding-Solo/godot-mcp/stargazers)
[![](https://img.shields.io/github/forks/Coding-Solo/godot-mcp 'Forks')](https://github.com/Coding-Solo/godot-mcp/network/members)
[![](https://img.shields.io/badge/License-MIT-red.svg 'MIT License')](https://opensource.org/licenses/MIT)


```text
                           (((((((             (((((((
                        (((((((((((           (((((((((((
                        (((((((((((((       (((((((((((((
                        (((((((((((((((((((((((((((((((((
                        (((((((((((((((((((((((((((((((((
         (((((      (((((((((((((((((((((((((((((((((((((((((      (((((
       (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
     ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
    ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
      (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
        (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         (((((((((((@@@@@@@(((((((((((((((((((((((((((@@@@@@@(((((((((((
         (((((((((@@@@,,,,,@@@(((((((((((((((((((((@@@,,,,,@@@@(((((((((
         ((((((((@@@,,,,,,,,,@@(((((((@@@@@(((((((@@,,,,,,,,,@@@((((((((
         ((((((((@@@,,,,,,,,,@@(((((((@@@@@(((((((@@,,,,,,,,,@@@((((((((
         (((((((((@@@,,,,,,,@@((((((((@@@@@((((((((@@,,,,,,,@@@(((((((((
         ((((((((((((@@@@@@(((((((((((@@@@@(((((((((((@@@@@@((((((((((((
         (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         @@@@@@@@@@@@@((((((((((((@@@@@@@@@@@@@((((((((((((@@@@@@@@@@@@@
         ((((((((( @@@(((((((((((@@(((((((((((@@(((((((((((@@@ (((((((((
         (((((((((( @@((((((((((@@@(((((((((((@@@((((((((((@@ ((((((((((
          (((((((((((@@@@@@@@@@@@@@(((((((((((@@@@@@@@@@@@@@(((((((((((
           (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
              (((((((((((((((((((((((((((((((((((((((((((((((((((((
                 (((((((((((((((((((((((((((((((((((((((((((((((
                        (((((((((((((((((((((((((((((((((


                          /$$      /$$  /$$$$$$  /$$$$$$$
                         | $$$    /$$$ /$$__  $$| $$__  $$
                         | $$$$  /$$$$| $$  \__/| $$  \ $$
                         | $$ $$/$$ $$| $$      | $$$$$$$/
                         | $$  $$$| $$| $$      | $$____/
                         | $$\  $ | $$| $$    $$| $$
                         | $$ \/  | $$|  $$$$$$/| $$
                         |__/     |__/ \______/ |__/
```

A Model Context Protocol (MCP) server for interacting with the Godot game engine.

## Introduction

Godot MCP enables AI agents to launch the Godot editor, run projects, capture debug output, and control project execution. This direct feedback loop helps agents understand what works and what doesn't in real Godot projects, leading to better code generation and debugging assistance.

## Features

- **Launch Godot Editor**: Open the Godot editor for a specific project
- **Run Godot Projects**: Execute Godot projects in debug mode
- **Run Godot Scenes**: Execute a specific scene with configurable timeout and captured output
- **Capture Debug Output**: Retrieve console output and error messages
- **Capture Screenshots**: Return a PNG of the running game to the agent, so it can check what the player sees
- **Simulate Input**: Click, drag, type, press keys and fire input actions in the running game
- **Control Execution**: Start and stop Godot projects programmatically
- **Get Godot Version**: Retrieve the installed Godot version
- **List Godot Projects**: Find Godot projects in a specified directory
- **Project Analysis**: Get detailed information about project structure
- **Scene Management**:
  - Create new scenes with specified root node types
  - Add nodes to existing scenes with customizable properties
  - Load sprites and textures into Sprite2D nodes
    - Texture files must be valid Godot-loadable image resources
    - Newly added or generated image files may need to be imported by Godot before `load_sprite` can use them
  - Export 3D scenes as MeshLibrary resources for GridMap
  - Save scenes with options for creating variants
- **UID Management** (for Godot 4.4+):
  - Get UID for specific files
  - Update UID references by resaving resources

### Run a Specific Scene

Use `run_scene` for an F6-style run of one scene while keeping output compatible with `get_debug_output` and `stop_project`.

| Parameter | Required | Description |
| --- | --- | --- |
| `projectPath` | Yes | Path to the directory containing `project.godot` |
| `scenePath` | Yes | A `res://` path or path relative to the project. `.tscn` and `.scn` are supported |
| `timeoutMs` | No | Stops the scene automatically after this many milliseconds. Defaults to `30000` |
| `args` | No | Arguments for the game, passed after `--` so the game reads them with `OS.get_cmdline_user_args()` |
| `harness` | No | Run the game under the harness main loop that `capture_screenshot` and `simulate_input` need. Defaults to `true` |
| `embedded` | No | macOS only. Run the game with no window, so it leaves your mouse and keyboard alone. Defaults to `false`. See [Run Without a Window](#run-without-a-window) |

```json
{
  "projectPath": "/path/to/project",
  "scenePath": "res://scenes/battle_scene.tscn",
  "timeoutMs": 30000,
  "args": ["--battle=1009"]
}
```

`run_project` takes the same `args`. Only one Godot process runs at a time, so starting a run stops the previous one. `get_debug_output` keeps working after the process exits, crashes or times out, and reports `running`, `exitCode` and `stoppedByTimeout` next to the last 1000 lines of stdout and stderr. `stop_project` returns the final output and clears it.

Both tools pass `-d`, which turns on Godot's local debugger. A runtime script error pauses the game at a `debug>` prompt, and the error shows up in `get_debug_output`. Call `stop_project` to end it.

### Capture Screenshots

`capture_screenshot` returns a PNG of what the game started by `run_project` or `run_scene` is drawing right now, as an image the agent can look at. Pass `savePath`, an absolute path ending in `.png`, to also write it to disk.

The image is in the game's viewport coordinates, the ones node positions use. With stretch mode `canvas_items` or `viewport` it has the base size from the project settings, whatever the window size or screen scale, so a project with an 800x600 base and a 1600x1200 window gives 800x600 screenshots.

Nothing is installed into the project. Both run tools start Godot with `-s build/scripts/mcp_harness.gd`, which makes the harness the game's main loop. It is a `SceneTree`, so the project's autoloads, its main scene or the scene you passed, and your `args` load as usual. The harness never writes files.

The harness listens on `127.0.0.1` only, on a free port the server picks for each run, and only answers requests that carry a random token made for that run. The server hands both to the game in the `GODOT_MCP_HARNESS_PORT` and `GODOT_MCP_HARNESS_TOKEN` environment variables, and the game prints `[godot-mcp harness] listening on 127.0.0.1:<port>` once it is ready. The harness stays closed in a release build.

Pass `harness: false` to `run_project` or `run_scene` for a project that sets its own main loop type, since `-s` takes its place. `capture_screenshot` and `simulate_input` then refuse to run.

A game that runs headless draws nothing, so the call fails. Godot also stops drawing a window that is minimized, hidden or covered, so the call fails within 3 seconds and names that as the likely cause. While a script error holds the game at the `debug>` prompt, the call times out after 15 seconds.

### Simulate Input

`simulate_input` sends a list of commands to the game started by `run_project` or `run_scene` and runs them in order, through the same harness. Positions are in the game's viewport coordinates, so a point read off a screenshot, or a node position from a scene file, is the point to click.

| Command | Fields |
| --- | --- |
| `click` | `x`, `y`, `button` (`left`, `right` or `middle`, default `left`), `double` |
| `mouse_move` | `x`, `y` |
| `mouse_drag` | `from_x`, `from_y`, `to_x`, `to_y`, `button` |
| `key` | `key`, a Godot key name such as `A`, `Space`, `Enter`, `Escape`, `Up`, `F5` or `Ctrl+S`, and `modifiers` from `shift`, `ctrl`, `alt` and `meta` |
| `action` | `action` from the Input Map or a built-in one such as `ui_accept`, and `pressed` (default `true`) |
| `action_pulse` | `action`, and `duration_ms` to hold it (default `100`) |
| `text` | `text`, and `delay_ms` between characters (default `50`) |
| `wait` | `duration_ms` (default `100`) |
| `screenshot` | No fields. The image comes back with the result |

```json
{
  "commands": [
    { "type": "click", "x": 480, "y": 260 },
    { "type": "action_pulse", "action": "ui_accept" },
    { "type": "wait", "duration_ms": 500 },
    { "type": "screenshot" }
  ]
}
```

Events go through `Input.parse_input_event()`, so the game gets them like real input. GUI controls react, actions bound to a key fire, and `_input` and `_unhandled_input` receive them. The `action` commands send `InputEventAction` events. The sequence stops at the first command that fails and says which one. `timeoutMs` (default `30000`) covers the whole sequence, and when it runs out the harness drops the remaining commands instead of sending them late, and the next request can run.

The real mouse cursor stays put unless you pass `warpMouse: true`. Clicks, drags and GUI hover work without it, but `get_global_mouse_position()` and `get_mouse_position()` read the real cursor, so a game that aims or hovers with those needs it. Warping moves the cursor on your desktop. A game started with `embedded: true` follows the injected position in those calls and needs no warp.

### Run Without a Window

Pass `embedded: true` to `run_project` or `run_scene` on macOS to drive a game without it touching your mouse, keyboard or focus. Godot starts in `--embedded` mode, the one the editor's game view uses, so there is no window and no Dock icon and the game never takes focus.

`capture_screenshot` and `simulate_input` work as usual, and frames keep rendering with nothing on screen, so a covered window is not a problem. `get_global_mouse_position()` and `get_mouse_position()` follow injected motion instead of the real cursor, and `warpMouse` no longer moves your cursor.

The mode is undocumented and can change with an engine upgrade, and it needs the harness. The window size cannot change, so the game keeps its project's window size.

### Run GUT Tests

`run_gut_tests` runs [GUT](https://github.com/bitwes/Gut) through `res://addons/gut/gut_cmdln.gd`, waits for it, and returns the output. The call fails when GUT exits non-zero, which it does when a test fails.

| Parameter | Required | Description |
| --- | --- | --- |
| `projectPath` | Yes | Path to the directory containing `project.godot` |
| `test` | No | `res://` test scripts to run. Only these run, even when `.gutconfig.json` lists dirs |
| `dir` | No | `res://` directories to search instead of the `.gutconfig.json` dirs |
| `unitTestName` | No | Only run tests whose name contains this text |
| `select` | No | Only run scripts whose file name contains this text |
| `innerClass` | No | Only run inner test classes whose name contains this text |
| `includeSubdirs` | No | Search subdirectories of `dir`. Defaults to `true` |
| `headless` | No | Run without a window. Defaults to `true` |
| `log` | No | GUT log level from 0 to 3 |
| `timeoutMs` | No | Stops the run after this many milliseconds. Defaults to `600000` |

With neither `test` nor `dir`, GUT runs what `.gutconfig.json` lists. One run happens at a time.

```json
{
  "projectPath": "/path/to/project",
  "test": ["res://test/unit/test_battle_runner.gd"],
  "unitTestName": "misses"
}
```

## Requirements

- [Godot Engine](https://godotengine.org/download) installed on your system
- [Bun](https://bun.sh) 1.x
- An AI agent that supports MCP

## Quick Start

### Claude Code

```bash
claude mcp add godot -- bunx @coding-solo/godot-mcp
```

That's it. Restart Claude Code and your Godot MCP tools are available.

With environment variables:

```bash
claude mcp add godot -e GODOT_PATH=/path/to/godot -e DEBUG=true -- bunx @coding-solo/godot-mcp
```

<details>
<summary><strong>Cline</strong></summary>

Add to your Cline MCP settings file (`~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "godot": {
      "command": "bunx",
      "args": ["@coding-solo/godot-mcp"],
      "env": {
        "DEBUG": "true"
      },
      "disabled": false,
      "autoApprove": [
        "launch_editor",
        "run_project",
        "run_scene",
        "get_debug_output",
        "stop_project",
        "capture_screenshot",
        "simulate_input",
        "run_gut_tests",
        "get_godot_version",
        "list_projects",
        "get_project_info",
        "create_scene",
        "add_node",
        "load_sprite",
        "export_mesh_library",
        "save_scene",
        "get_uid",
        "update_project_uids"
      ]
    }
  }
}
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

**Using the Cursor UI:**

1. Go to **Cursor Settings** > **Features** > **MCP**
2. Click on the **+ Add New MCP Server** button
3. Fill out the form:
   - Name: `godot`
   - Type: `command`
   - Command: `bunx @coding-solo/godot-mcp`
4. Click "Add"
5. You may need to press the refresh button in the top right corner of the MCP server card to populate the tool list

**Using Project-Specific Configuration:**

Create a file at `.cursor/mcp.json` in your project directory:

```json
{
  "mcpServers": {
    "godot": {
      "command": "bunx",
      "args": ["@coding-solo/godot-mcp"],
      "env": {
        "DEBUG": "true"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Other MCP Clients</strong></summary>

For any MCP-compatible client, use this configuration:

```json
{
  "mcpServers": {
    "godot": {
      "command": "bunx",
      "args": ["@coding-solo/godot-mcp"],
      "env": {
        "GODOT_PATH": "/path/to/godot",
        "DEBUG": "true"
      }
    }
  }
}
```

</details>

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GODOT_PATH` | Path to the Godot executable (overrides automatic detection) |
| `DEBUG` | Set to `"true"` to enable detailed server-side debug logging |

<details>
<summary><strong>Building from Source</strong></summary>

```bash
git clone https://github.com/Coding-Solo/godot-mcp.git
cd godot-mcp
bun install
bun run build
```

Then point your MCP client at `bun /path/to/godot-mcp/build/index.js` instead of `bunx`, for example `claude mcp add godot -- bun /path/to/godot-mcp/build/index.js`. `bun run test` runs the tests, and the `run_scene` test only runs when `GODOT_PATH` is set.

</details>


## Architecture

The Godot MCP server uses a bundled GDScript approach for complex operations:

1. **Direct Commands**: Simple operations like launching the editor or getting project info use Godot's built-in CLI commands directly.
2. **Bundled Operations Script**: Complex operations like creating scenes or adding nodes use a single, comprehensive GDScript file (`godot_operations.gd`) that handles all operations.
3. **Harness Main Loop**: `run_project` and `run_scene` pass `mcp_harness.gd` to Godot with `-s`, so `capture_screenshot` and `simulate_input` can reach the running game without installing anything into the project.

The bundled script accepts operation type and parameters as JSON, allowing for flexible and dynamic operation execution without generating temporary files for each operation.

## Troubleshooting

- **Godot Not Found**: Set the `GODOT_PATH` environment variable to your Godot executable path
- **Connection Issues**: Ensure the server is running and restart your AI assistant
- **Invalid Project Path**: Ensure the path points to a directory containing a `project.godot` file
- **Build Issues**: Make sure all dependencies are installed by running `bun install`
- **`load_sprite` fails with `No loader found for resource`**:
  - Verify the image file is not corrupt
  - Make sure the format is supported by your Godot import pipeline
  - If the image was newly added or generated outside the editor, run a Godot import pass before calling `load_sprite`, for example `godot --headless --import --path /path/to/project`

<details>
<summary><strong>Cursor-Specific Issues</strong></summary>

- Ensure the MCP server shows up and is enabled in Cursor settings (Settings > MCP)
- MCP tools can only be run using the Agent chat profile (Cursor Pro or Business subscription)
- Use "Yolo Mode" to automatically run MCP tool requests

</details>

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
