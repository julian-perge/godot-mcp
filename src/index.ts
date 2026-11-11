#!/usr/bin/env node
/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { fileURLToPath } from 'url';
import { join, dirname, basename, normalize, isAbsolute } from 'path';
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process';
import { promisify } from 'util';
import { createConnection, createServer } from 'net';
import { randomBytes } from 'crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

// Check if debug mode is enabled
const DEBUG_MODE: boolean = process.env.DEBUG === 'true';
const GODOT_DEBUG_MODE: boolean = true; // Always use GODOT DEBUG MODE
const DEFAULT_SCENE_TIMEOUT_MS = 30000;
const MAX_SCENE_TIMEOUT_MS = 2147483647;
const PROCESS_EXIT_WAIT_MS = 1000;
const OUTPUT_BUFFER_LIMIT = 1000; // Max lines to keep per stream
const DEFAULT_GUT_TIMEOUT_MS = 600000;
const GUT_OUTPUT_LIMIT_CHARS = 200000; // Tail of GUT stdout returned to the client
const DEFAULT_INPUT_TIMEOUT_MS = 30000;
const NO_WINDOW_NOTE = ' The game has no window, so use capture_screenshot to see it.';

const execFileAsync = promisify(execFile);

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve a Godot resource path (e.g. "res://scenes/Main.tscn") to an
 * absolute path inside the project directory. Falls back to a plain join
 * when the path has no res:// prefix.
 */
function resolveResourcePath(projectPath: string, resourcePath: string): string {
  return join(projectPath, resourcePath.replace(/^res:\/\//, ''));
}

/**
 * A Godot process started by run_project or run_scene. The record outlives
 * the process, so its output and exit status can still be read after a
 * crash or a timeout, until the next run or stop_project replaces it.
 */
interface GodotProcess {
  process: ChildProcessWithoutNullStreams;
  description: string;
  projectPath: string;
  scene?: string;
  args: string[];
  output: string[];
  errors: string[];
  droppedOutputLines: number;
  droppedErrorLines: number;
  startedAt: Date;
  isRunning: boolean;
  exitedAt?: Date;
  exitCode?: number | null;
  exitSignal?: string | null;
  stoppedByTimeout?: boolean;
  timeout?: NodeJS.Timeout;
  // Where mcp_harness.gd listens in this game, when it was started with the harness
  harness?: { port: number; token: string };
}

/**
 * Options for startGodotProcess
 */
interface StartProcessOptions {
  projectPath: string;
  scene?: string;
  args: string[];
  harness: boolean;
  embedded: boolean;
  timeoutMs?: number;
}

/**
 * One line of JSON that mcp_harness.gd answers a request with
 */
interface HarnessResponse {
  ok: boolean;
  error?: string;
  results?: Array<Record<string, any>>;
}

/**
 * Interface for server configuration
 */
interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
  godotDebugMode?: boolean;
  strictPathValidation?: boolean; // New option to control path validation behavior
}

/**
 * Interface for operation parameters
 */
interface OperationParams {
  [key: string]: any;
}

// The input schemas sit outside setupToolHandlers so that each handler can take
// the argument type that Zod infers from its schema.
const launchEditorSchema = z.object({
  projectPath: z.string().describe('Path to the Godot project directory'),
});
type LaunchEditorArgs = z.infer<typeof launchEditorSchema>;

const runProjectSchema = z.object({
  projectPath: z.string().describe('Path to the Godot project directory'),
  scene: z.string().optional().describe('Optional: Specific scene to run'),
  args: z.array(z.string()).optional().describe('Optional: Arguments for the game, e.g. ["--battle=1009"]. They are passed after "--", so the game reads them with OS.get_cmdline_user_args() and they cannot change engine options.'),
  harness: z.boolean().optional().describe('Optional: Run the game under the godot-mcp harness main loop so capture_screenshot and simulate_input work (default: true). Nothing is written to the project. Set false for a project with its own main loop type.'),
  embedded: z.boolean().optional().describe('Optional: macOS only (default: false). Run the game with no window, through Godot\'s undocumented --embedded editor mode. It never takes focus, get_global_mouse_position() follows simulate_input so warpMouse is not needed, and capture_screenshot works with nothing on screen. Needs the harness.'),
});
type RunProjectArgs = z.infer<typeof runProjectSchema>;

const runSceneSchema = z.object({
  projectPath: z.string().describe('Path to the Godot project directory'),
  scenePath: z.string().describe('Scene to run, as a res:// path or a path relative to the project'),
  timeoutMs: z.number().int().min(1).max(MAX_SCENE_TIMEOUT_MS).optional().describe('Time in milliseconds before the scene is stopped automatically (default: 30000)'),
  args: z.array(z.string()).optional().describe('Optional: Arguments for the game, e.g. ["--battle=1009"]. They are passed after "--", so the game reads them with OS.get_cmdline_user_args() and they cannot change engine options.'),
  harness: z.boolean().optional().describe('Optional: Run the game under the godot-mcp harness main loop so capture_screenshot and simulate_input work (default: true). Nothing is written to the project. Set false for a project with its own main loop type.'),
  embedded: z.boolean().optional().describe('Optional: macOS only (default: false). Run the game with no window, through Godot\'s undocumented --embedded editor mode. It never takes focus, get_global_mouse_position() follows simulate_input so warpMouse is not needed, and capture_screenshot works with nothing on screen. Needs the harness.'),
});
type RunSceneArgs = z.infer<typeof runSceneSchema>;

const captureScreenshotSchema = z.object({
  savePath: z.string().optional().describe('Optional: Absolute path of a .png file to also write the screenshot to'),
});
type CaptureScreenshotArgs = z.infer<typeof captureScreenshotSchema>;

const simulateInputSchema = z.object({
  commands: z.array(z.object({
    type: z.enum(['click', 'mouse_move', 'mouse_drag', 'key', 'action', 'action_pulse', 'text', 'wait', 'screenshot']),
    x: z.number().optional(),
    y: z.number().optional(),
    from_x: z.number().optional(),
    from_y: z.number().optional(),
    to_x: z.number().optional(),
    to_y: z.number().optional(),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default: left)'),
    double: z.boolean().optional().describe('Send a double click (default: false)'),
    key: z.string().optional().describe('Godot key name such as "A", "Space", "Enter", "Escape", "Up" or "F5". A name such as "Ctrl+S" also works.'),
    modifiers: z.array(z.enum(['shift', 'ctrl', 'alt', 'meta'])).optional(),
    action: z.string().optional().describe('Input action from the project\'s Input Map, or a built-in one such as "ui_accept"'),
    pressed: z.boolean().optional().describe('Press or release the action (default: true)'),
    duration_ms: z.number().optional().describe('How long action_pulse holds the action, or how long wait waits (default: 100)'),
    text: z.string().optional().describe('Characters to type'),
    delay_ms: z.number().optional().describe('Pause between typed characters (default: 50)'),
  })).describe('Commands to run in order: click {x, y, button?, double?}, mouse_move {x, y}, mouse_drag {from_x, from_y, to_x, to_y, button?}, key {key, modifiers?}, action {action, pressed?}, action_pulse {action, duration_ms?}, text {text, delay_ms?}, wait {duration_ms?}, screenshot {}'),
  warpMouse: z.boolean().optional().describe('Optional: Also move the real mouse cursor to each position (default: false). Only needed when the game reads the cursor with get_global_mouse_position() or get_mouse_position(). It moves the cursor on the desktop.'),
  timeoutMs: z.number().optional().describe('Optional: How long to wait for the whole sequence in milliseconds (default: 30000)'),
});
type SimulateInputArgs = z.infer<typeof simulateInputSchema>;

const runGutTestsSchema = z.object({
  projectPath: z.string().describe('Path to the Godot project directory'),
  test: z.array(z.string()).optional().describe('Optional: res:// test scripts to run, e.g. ["res://test/unit/test_battle.gd"]. The .gutconfig.json dirs are skipped unless dir is also given.'),
  dir: z.array(z.string()).optional().describe('Optional: res:// directories to search for tests instead of the .gutconfig.json dirs, e.g. ["res://test/unit"]'),
  unitTestName: z.string().optional().describe('Optional: Only run tests whose name contains this text (-gunit_test_name)'),
  select: z.string().optional().describe('Optional: Only run scripts whose file name contains this text (-gselect)'),
  innerClass: z.string().optional().describe('Optional: Only run inner test classes whose name contains this text (-ginner_class)'),
  includeSubdirs: z.boolean().optional().describe('Optional: Search subdirectories of dir (default: true)'),
  headless: z.boolean().optional().describe('Optional: Run without a window (default: true). Use false for tests that need rendering.'),
  log: z.number().int().min(0).max(3).optional().describe('Optional: GUT log level 0-3'),
  timeoutMs: z.number().int().min(1).max(MAX_SCENE_TIMEOUT_MS).optional().describe('Optional: Stop the run after this many milliseconds (default: 600000)'),
});
type RunGutTestsArgs = z.infer<typeof runGutTestsSchema>;

const listProjectsSchema = z.object({
  directory: z.string().describe('Directory to search for Godot projects'),
  recursive: z.boolean().optional().describe('Whether to search recursively (default: false)'),
});
type ListProjectsArgs = z.infer<typeof listProjectsSchema>;

const getProjectInfoSchema = z.object({
  projectPath: z.string().describe('Path to the Godot project directory'),
});
type GetProjectInfoArgs = z.infer<typeof getProjectInfoSchema>;

const createSceneSchema = z.object({
  projectPath: z.string().describe('Path to the Godot project directory'),
  scenePath: z.string().describe('Path where the scene file will be saved (relative to project)'),
  rootNodeType: z.string().optional().describe('Type of the root node (e.g., Node2D, Node3D)'),
});
type CreateSceneArgs = z.infer<typeof createSceneSchema>;

const addNodeSchema = z.object({
  projectPath: z.string().describe('Path to the Godot project directory'),
  scenePath: z.string().describe('Path to the scene file (relative to project)'),
  parentNodePath: z.string().optional().describe('Path to the parent node (e.g., "root" or "root/Player")'),
  nodeType: z.string().describe('Type of node to add (e.g., Sprite2D, CollisionShape2D)'),
  nodeName: z.string().describe('Name for the new node'),
  // A loose object keeps every key the caller sends. A plain z.object
  // would drop them all, since it declares no keys.
  properties: z.looseObject({}).optional().describe('Optional properties to set on the node'),
});
type AddNodeArgs = z.infer<typeof addNodeSchema>;

const loadSpriteSchema = z.object({
  projectPath: z.string().describe('Path to the Godot project directory'),
  scenePath: z.string().describe('Path to the scene file (relative to project)'),
  nodePath: z.string().describe('Path to the Sprite2D node (e.g., "root/Player/Sprite2D")'),
  texturePath: z.string().describe('Path to the texture file (relative to project)'),
});
type LoadSpriteArgs = z.infer<typeof loadSpriteSchema>;

const exportMeshLibrarySchema = z.object({
  projectPath: z.string().describe('Path to the Godot project directory'),
  scenePath: z.string().describe('Path to the scene file (.tscn) to export'),
  outputPath: z.string().describe('Path where the mesh library (.res) will be saved'),
  meshItemNames: z.array(z.string()).optional().describe('Optional: Names of specific mesh items to include (defaults to all)'),
});
type ExportMeshLibraryArgs = z.infer<typeof exportMeshLibrarySchema>;

const saveSceneSchema = z.object({
  projectPath: z.string().describe('Path to the Godot project directory'),
  scenePath: z.string().describe('Path to the scene file (relative to project)'),
  newPath: z.string().optional().describe('Optional: New path to save the scene to (for creating variants)'),
});
type SaveSceneArgs = z.infer<typeof saveSceneSchema>;

const getUidSchema = z.object({
  projectPath: z.string().describe('Path to the Godot project directory'),
  filePath: z.string().describe('Path to the file (relative to project) for which to get the UID'),
});
type GetUidArgs = z.infer<typeof getUidSchema>;

const updateProjectUidsSchema = z.object({
  projectPath: z.string().describe('Path to the Godot project directory'),
});
type UpdateProjectUidsArgs = z.infer<typeof updateProjectUidsSchema>;

const viewLogSchema = z.object({
  lineCount: z.number().optional().describe('Number of trailing lines to return (default 50, max 1000)'),
});
type ViewLogArgs = z.infer<typeof viewLogSchema>;
/**
 * Main server class for the Godot MCP server
 */
class GodotServer {
  private server: McpServer;
  private currentProcess: GodotProcess | null = null;
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private validatedPaths: Map<string, boolean> = new Map();
  private strictPathValidation: boolean = false;
  // Last lines the editor started by launch_editor printed, cleared on each launch
  private editorLogLines: string[] = [];
  // Track the editor process spawned by launch_editor so quit_godot can close it
  private editorProcess: ChildProcessWithoutNullStreams | null = null;
  // The GUT run in progress, so a second call is refused and cleanup can stop it
  private gutProcess: ChildProcessWithoutNullStreams | null = null;
  private harnessScriptPath: string;
  // Harness requests run one at a time, so two tool calls never interleave
  private harnessQueue: Promise<unknown> = Promise.resolve();

  constructor(config?: GodotServerConfig) {
    // Apply configuration if provided
    let debugMode = DEBUG_MODE;
    let godotDebugMode = GODOT_DEBUG_MODE;

    if (config) {
      if (config.debugMode !== undefined) {
        debugMode = config.debugMode;
      }
      if (config.godotDebugMode !== undefined) {
        godotDebugMode = config.godotDebugMode;
      }
      if (config.strictPathValidation !== undefined) {
        this.strictPathValidation = config.strictPathValidation;
      }

      // Store and validate custom Godot path if provided
      if (config.godotPath) {
        const normalizedPath = normalize(config.godotPath);
        this.godotPath = normalizedPath;
        this.logDebug(`Custom Godot path provided: ${this.godotPath}`);

        // Validate immediately with sync check
        if (!this.isValidGodotPathSync(this.godotPath)) {
          console.warn(`[SERVER] Invalid custom Godot path provided: ${this.godotPath}`);
          this.godotPath = null; // Reset to trigger auto-detection later
        }
      }
    }

    // Set the path to the operations script
    this.operationsScriptPath = join(__dirname, 'scripts', 'godot_operations.gd');
    this.harnessScriptPath = join(__dirname, 'scripts', 'mcp_harness.gd');
    if (debugMode) console.error(`[DEBUG] Operations script path: ${this.operationsScriptPath}`);

    // Initialize the MCP server
    this.server = new McpServer({
      name: 'godot-mcp',
      version: '0.1.0',
    });

    // Set up tool handlers
    this.setupToolHandlers();

    // Error handling
    this.server.server.onerror = (error) => console.error('[MCP Error]', error);

    // A Godot child does not exit with this server, so a run left behind
    // keeps its window open after the client goes away. Stop it when the
    // client closes stdin or the server is asked to terminate.
    const shutdown = async () => {
      await this.cleanup();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGHUP', shutdown);
    process.stdin.on('end', shutdown);
  }

  /**
   * Log debug messages if debug mode is enabled
   * Using stderr instead of stdout to avoid interfering with JSON-RPC communication
   */
  private logDebug(message: string): void {
    if (DEBUG_MODE) {
      console.error(`[DEBUG] ${message}`);
    }
  }

  /**
   * Create a standardized error response with possible solutions
   */
  private createErrorResponse(message: string, possibleSolutions: string[] = []): any {
    // Log the error
    console.error(`[SERVER] Error response: ${message}`);
    if (possibleSolutions.length > 0) {
      console.error(`[SERVER] Possible solutions: ${possibleSolutions.join(', ')}`);
    }

    const response: any = {
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
      isError: true,
    };

    if (possibleSolutions.length > 0) {
      response.content.push({
        type: 'text',
        text: 'Possible solutions:\n- ' + possibleSolutions.join('\n- '),
      });
    }

    return response;
  }

  /**
   * Validate a path to prevent path traversal attacks
   */
  private validatePath(path: string): boolean {
    // Basic validation to prevent path traversal
    if (!path || path.includes('..')) {
      return false;
    }

    // Add more validation as needed
    return true;
  }

  /**
   * Validate a Godot class name to prevent arbitrary script instantiation.
   * Class names must be simple identifiers (e.g. "Node2D", "CharacterBody3D").
   * Rejects anything that looks like a path (res://, absolute paths, dots, slashes, colons).
   */
  private validateClassName(name: string): boolean {
    if (!name) return false;
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  }

  /**
   * Synchronous validation for constructor use
   * This is a quick check that only verifies file existence, not executable validity
   * Full validation will be performed later in detectGodotPath
   * @param path Path to check
   * @returns True if the path exists or is 'godot' (which might be in PATH)
   */
  private isValidGodotPathSync(path: string): boolean {
    try {
      this.logDebug(`Quick-validating Godot path: ${path}`);
      return path === 'godot' || existsSync(path);
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      return false;
    }
  }

  /**
   * Validate if a Godot path is valid and executable
   */
  private async isValidGodotPath(path: string): Promise<boolean> {
    // Check cache first
    if (this.validatedPaths.has(path)) {
      return this.validatedPaths.get(path)!;
    }

    try {
      this.logDebug(`Validating Godot path: ${path}`);

      // Check if the file exists (skip for 'godot' which might be in PATH)
      if (path !== 'godot' && !existsSync(path)) {
        this.logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }

      // Try to execute Godot with --version flag
      // Using execFileAsync with argument array to prevent command injection
      await execFileAsync(path, ['--version']);

      this.logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  /**
   * Detect the Godot executable path based on the operating system
   */
  private async detectGodotPath() {
    // If godotPath is already set and valid, use it
    if (this.godotPath && await this.isValidGodotPath(this.godotPath)) {
      this.logDebug(`Using existing Godot path: ${this.godotPath}`);
      return;
    }

    // Check environment variable next
    if (process.env.GODOT_PATH) {
      const normalizedPath = normalize(process.env.GODOT_PATH);
      this.logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      } else {
        this.logDebug(`GODOT_PATH environment variable is invalid`);
      }
    }

    // Auto-detect based on platform
    const osPlatform = process.platform;
    this.logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    const possiblePaths: string[] = [
      'godot', // Check if 'godot' is in PATH first
    ];

    // Add platform-specific paths
    if (osPlatform === 'darwin') {
      possiblePaths.push(
        '/Applications/Godot.app/Contents/MacOS/Godot',
        '/Applications/Godot_4.app/Contents/MacOS/Godot',
        `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`
      );
    } else if (osPlatform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        'C:\\Program Files\\Godot_4\\Godot.exe',
        'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
        `${process.env.USERPROFILE}\\Godot\\Godot.exe`
      );
    } else if (osPlatform === 'linux') {
      possiblePaths.push(
        '/usr/bin/godot',
        '/usr/local/bin/godot',
        '/snap/bin/godot',
        `${process.env.HOME}/.local/bin/godot`
      );
    }

    // Try each possible path
    for (const path of possiblePaths) {
      const normalizedPath = normalize(path);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Found Godot at: ${normalizedPath}`);
        return;
      }
    }

    // If we get here, we couldn't find Godot
    this.logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.`);

    if (this.strictPathValidation) {
      // In strict mode, throw an error
      throw new Error(`Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.`);
    } else {
      // Fallback to a default path in non-strict mode; this may not be valid and requires user configuration for reliability
      if (osPlatform === 'win32') {
        this.godotPath = normalize('C:\\Program Files\\Godot\\Godot.exe');
      } else if (osPlatform === 'darwin') {
        this.godotPath = normalize('/Applications/Godot.app/Contents/MacOS/Godot');
      } else {
        this.godotPath = normalize('/usr/bin/godot');
      }

      this.logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.`);
    }
  }

  /**
   * Set a custom Godot path
   * @param customPath Path to the Godot executable
   * @returns True if the path is valid and was set, false otherwise
   */
  public async setGodotPath(customPath: string): Promise<boolean> {
    if (!customPath) {
      return false;
    }

    // Normalize the path to ensure consistent format across platforms
    // (e.g., backslashes to forward slashes on Windows, resolving relative paths)
    const normalizedPath = normalize(customPath);
    if (await this.isValidGodotPath(normalizedPath)) {
      this.godotPath = normalizedPath;
      this.logDebug(`Godot path set to: ${normalizedPath}`);
      return true;
    }

    this.logDebug(`Failed to set invalid Godot path: ${normalizedPath}`);
    return false;
  }

  /**
   * Clean up resources when shutting down
   */
  private async cleanup() {
    this.logDebug('Cleaning up resources');
    if (this.currentProcess?.isRunning) {
      this.logDebug('Killing running Godot process');
      await this.stopCurrentProcess();
    }
    if (this.gutProcess) {
      this.logDebug('Killing running GUT process');
      this.gutProcess.kill('SIGKILL');
    }
    // The editor is left open on purpose. Cleanup runs whenever the client
    // disconnects, and the editor may hold unsaved work, so only quit_godot
    // closes it.
    await this.server.close();
  }

  /**
   * Check if the Godot version is 4.4 or later
   * @param version The Godot version string
   * @returns True if the version is 4.4 or later
   */
  private isGodot44OrLater(version: string): boolean {
    const match = version.match(/^(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      return major > 4 || (major === 4 && minor >= 4);
    }
    return false;
  }

  /**
   * Convert camelCase keys to snake_case
   * @param params Object with camelCase keys
   * @returns Object with snake_case keys
   */
  private convertCamelToSnakeCase(params: OperationParams): OperationParams {
    const result: OperationParams = {};
    
    for (const key in params) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        // Convert camelCase to snake_case
        const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
        
        // Handle nested objects recursively
        if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
          result[snakeKey] = this.convertCamelToSnakeCase(params[key] as OperationParams);
        } else {
          result[snakeKey] = params[key];
        }
      }
    }
    
    return result;
  }

  /**
   * Execute a Godot operation using the operations script
   * @param operation The operation to execute
   * @param params The parameters for the operation
   * @param projectPath The path to the Godot project
   * @returns The stdout and stderr from the operation
   */
  private async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string
  ): Promise<{ stdout: string; stderr: string }> {
    this.logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    this.logDebug(`Original operation params: ${JSON.stringify(params)}`);

    // Convert camelCase parameters to snake_case for Godot script
    const snakeCaseParams = this.convertCamelToSnakeCase(params);
    this.logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);


    // Ensure godotPath is set
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    try {
      // Serialize the snake_case parameters to a valid JSON string
      const paramsJson = JSON.stringify(snakeCaseParams);

      // Build argument array for execFile to prevent command injection
      // Using execFile with argument arrays avoids shell interpretation entirely
      const args = [
        '--headless',
        '--path',
        projectPath,  // Safe: passed as argument, not interpolated into shell command
        '--script',
        this.operationsScriptPath,
        operation,
        paramsJson,  // Safe: passed as argument, not interpreted by shell
      ];

      
      if (GODOT_DEBUG_MODE) {
        args.push('--debug-godot');
      }

      this.logDebug(`Executing: ${this.godotPath} ${args.join(' ')}`);

      const { stdout, stderr } = await execFileAsync(this.godotPath!, args);

      return { stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (error: unknown) {
      // If execFileAsync throws, it still contains stdout/stderr
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string; stderr: string };
        return {
          stdout: execError.stdout ?? '',
          stderr: execError.stderr ?? '',
        };
      }

      throw error;
    }
  }

  /**
   * Get the structure of a Godot project
   * @param projectPath Path to the Godot project
   * @returns Object representing the project structure
   */
  private async getProjectStructure(projectPath: string): Promise<any> {
    try {
      // Get top-level directories in the project
      const entries = readdirSync(projectPath, { withFileTypes: true });

      const structure: any = {
        scenes: [],
        scripts: [],
        assets: [],
        other: [],
      };

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirName = entry.name.toLowerCase();

          // Skip hidden directories
          if (dirName.startsWith('.')) {
            continue;
          }

          // Count files in common directories
          if (dirName === 'scenes' || dirName.includes('scene')) {
            structure.scenes.push(entry.name);
          } else if (dirName === 'scripts' || dirName.includes('script')) {
            structure.scripts.push(entry.name);
          } else if (
            dirName === 'assets' ||
            dirName === 'textures' ||
            dirName === 'models' ||
            dirName === 'sounds' ||
            dirName === 'music'
          ) {
            structure.assets.push(entry.name);
          } else {
            structure.other.push(entry.name);
          }
        }
      }

      return structure;
    } catch (error) {
      this.logDebug(`Error getting project structure: ${error}`);
      return { error: 'Failed to get project structure' };
    }
  }

  /**
   * Find Godot projects in a directory
   * @param directory Directory to search
   * @param recursive Whether to search recursively
   * @returns Array of Godot projects
   */
  private findGodotProjects(directory: string, recursive: boolean): Array<{ path: string; name: string }> {
    const projects: Array<{ path: string; name: string }> = [];

    try {
      // Check if the directory itself is a Godot project
      const projectFile = join(directory, 'project.godot');
      if (existsSync(projectFile)) {
        projects.push({
          path: directory,
          name: basename(directory),
        });
      }

      // If not recursive, only check immediate subdirectories
      if (!recursive) {
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            }
          }
        }
      } else {
        // Recursive search
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            // Skip hidden directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            // Check if this directory is a Godot project
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            } else {
              // Recursively search this directory
              const subProjects = this.findGodotProjects(subdir, true);
              projects.push(...subProjects);
            }
          }
        }
      }
    } catch (error) {
      this.logDebug(`Error searching directory ${directory}: ${error}`);
    }

    return projects;
  }

  /**
   * Register the tools with the MCP server
   */
  private setupToolHandlers() {
    this.server.registerTool(
      'launch_editor',
      {
        description: 'Launch Godot editor for a specific project',
        inputSchema: launchEditorSchema,
      },
      (args) => this.handleLaunchEditor(args)
    );

    this.server.registerTool(
      'run_project',
      {
        description: 'Run the Godot project and capture output. Starting a run stops the previous one. The game runs with Godot\'s local debugger, so a runtime script error pauses it at a "debug>" prompt that get_debug_output shows.',
        inputSchema: runProjectSchema,
      },
      (args) => this.handleRunProject(args)
    );

    this.server.registerTool(
      'run_scene',
      {
        description: 'Run a specific Godot scene and capture output. Starting a run stops the previous one. The game runs with Godot\'s local debugger, so a runtime script error pauses it at a "debug>" prompt that get_debug_output shows.',
        inputSchema: runSceneSchema,
      },
      (args) => this.handleRunScene(args)
    );

    this.server.registerTool(
      'capture_screenshot',
      {
        description: 'Capture a PNG of what the game started by run_project or run_scene is rendering right now, returned as an image. The image is in the game\'s viewport coordinates, the ones node positions use, so with stretch mode canvas_items or viewport it has the project\'s base size whatever the window size. Fails for a headless game or a window that is minimized, hidden or covered, and times out while a script error holds the game at a "debug>" prompt.',
        inputSchema: captureScreenshotSchema,
      },
      (args) => this.handleCaptureScreenshot(args)
    );

    this.server.registerTool(
      'simulate_input',
      {
        description: 'Send mouse, keyboard and input action events to the game started by run_project or run_scene, one command after another, and return the screenshots taken along the way. Positions are in the game\'s viewport coordinates, the same pixels capture_screenshot returns. The sequence stops at the first command that fails.',
        inputSchema: simulateInputSchema,
      },
      (args) => this.handleSimulateInput(args)
    );

    this.server.registerTool(
      'get_debug_output',
      {
        description: 'Get the output, errors and status of the last run_project or run_scene process. Works while it runs and after it exits, crashes or times out, until the next run or stop_project. Keeps the last 1000 lines of each stream.',
      },
      () => this.handleGetDebugOutput()
    );

    this.server.registerTool(
      'stop_project',
      {
        description: 'Stop the Godot process started by run_project or run_scene and return its final output',
      },
      () => this.handleStopProject()
    );

    this.server.registerTool(
      'run_gut_tests',
      {
        description: 'Run GUT tests (res://addons/gut/gut_cmdln.gd) and wait for the result. With no test or dir it runs what .gutconfig.json lists. Passing test runs only those scripts. Fails when GUT reports failures or exits non-zero.',
        inputSchema: runGutTestsSchema,
      },
      (args) => this.handleRunGutTests(args)
    );

    this.server.registerTool(
      'get_godot_version',
      {
        description: 'Get the installed Godot version',
      },
      () => this.handleGetGodotVersion()
    );

    this.server.registerTool(
      'list_projects',
      {
        description: 'List Godot projects in a directory',
        inputSchema: listProjectsSchema,
      },
      (args) => this.handleListProjects(args)
    );

    this.server.registerTool(
      'get_project_info',
      {
        description: 'Retrieve metadata about a Godot project',
        inputSchema: getProjectInfoSchema,
      },
      (args) => this.handleGetProjectInfo(args)
    );

    this.server.registerTool(
      'create_scene',
      {
        description: 'Create a new Godot scene file',
        inputSchema: createSceneSchema,
      },
      (args) => this.handleCreateScene(args)
    );

    this.server.registerTool(
      'add_node',
      {
        description: 'Add a node to an existing scene',
        inputSchema: addNodeSchema,
      },
      (args) => this.handleAddNode(args)
    );

    this.server.registerTool(
      'load_sprite',
      {
        description: 'Load a sprite into a Sprite2D node',
        inputSchema: loadSpriteSchema,
      },
      (args) => this.handleLoadSprite(args)
    );

    this.server.registerTool(
      'export_mesh_library',
      {
        description: 'Export a scene as a MeshLibrary resource',
        inputSchema: exportMeshLibrarySchema,
      },
      (args) => this.handleExportMeshLibrary(args)
    );

    this.server.registerTool(
      'save_scene',
      {
        description: 'Save changes to a scene file',
        inputSchema: saveSceneSchema,
      },
      (args) => this.handleSaveScene(args)
    );

    this.server.registerTool(
      'get_uid',
      {
        description: 'Get the UID for a specific file in a Godot project (for Godot 4.4+)',
        inputSchema: getUidSchema,
      },
      (args) => this.handleGetUid(args)
    );

    this.server.registerTool(
      'update_project_uids',
      {
        description: 'Update UID references in a Godot project by resaving resources (for Godot 4.4+)',
        inputSchema: updateProjectUidsSchema,
      },
      (args) => this.handleUpdateProjectUids(args)
    );

    this.server.registerTool(
      'view_log',
      {
        description: 'View recent console output from the editor started by launch_editor, such as script parse errors. Returns the last N lines of captured stdout and stderr. For run_project and run_scene output use get_debug_output.',
        inputSchema: viewLogSchema,
      },
      (args) => this.handleViewLog(args)
    );

    this.server.registerTool(
      'quit_godot',
      {
        description: 'Close the Godot editor that was launched by this MCP server via launch_editor. Only closes editors spawned by this server. Unsaved changes in that editor are lost.',
      },
      () => this.handleQuitGodot()
    );
  }

  /**
   * Handle the launch_editor tool
   * @param args Tool arguments
   */
  private async handleLaunchEditor(args: LaunchEditorArgs) {
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      if (this.editorProcess) {
        return this.createErrorResponse(
          'An editor started by launch_editor is still running',
          [
            'Use quit_godot to close it first',
            'Only one editor is tracked, so a second launch would leave the first one unmanaged',
          ]
        );
      }

      this.logDebug(`Launching Godot editor for project: ${args.projectPath}`);

      // Clear the log buffer on each new launch
      this.editorLogLines = [];

      const process = spawn(this.godotPath, ['-e', '--path', args.projectPath], {
        stdio: 'pipe',
      });

      const keepEditorLine = (stream: 'stdout' | 'stderr') => (line: string) => {
        const cleaned = line.replace(/\r/g, '').trimEnd();
        if (!cleaned) {
          return;
        }
        this.editorLogLines.push(`[${stream}] ${cleaned}`);
        if (this.editorLogLines.length > OUTPUT_BUFFER_LIMIT) {
          this.editorLogLines.shift();
        }
      };
      const stdoutLines = this.lineSplitter(keepEditorLine('stdout'));
      const stderrLines = this.lineSplitter(keepEditorLine('stderr'));
      process.stdout?.on('data', stdoutLines.push);
      process.stderr?.on('data', stderrLines.push);

      // Track the spawned editor so quit_godot can close it later
      this.editorProcess = process;

      process.on('exit', () => {
        stdoutLines.flush();
        stderrLines.flush();
        if (this.editorProcess === process) {
          this.logDebug('Godot editor exited naturally');
          this.editorProcess = null;
        }
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot editor:', err);
        this.editorLogLines.push(`[spawn error] ${err.message}`);
      });

      return {
        content: [
          {
            type: 'text',
            text: `Godot editor launched for project at ${args.projectPath}. Use view_log to check the console output.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to launch Godot editor: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the run_project tool
   * @param args Tool arguments
   */
  private async handleRunProject(args: RunProjectArgs) {
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      const userArgs = this.parseUserArgs(args.args);

      const embeddedProblem = this.embeddedOptionProblem(args.embedded, args.harness);
      if (embeddedProblem) {
        return this.createErrorResponse(embeddedProblem, ['Omit embedded to run the game in a normal window']);
      }

      const scene = args.scene && this.validatePath(args.scene) ? args.scene : undefined;
      if (scene) {
        this.logDebug(`Adding scene parameter: ${scene}`);
      }

      this.logDebug(`Running Godot project: ${args.projectPath}`);
      await this.startGodotProcess('project', {
        projectPath: args.projectPath,
        scene,
        args: userArgs,
        harness: args.harness !== false,
        embedded: args.embedded === true,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Godot project started in debug mode. Use get_debug_output to see output.${args.embedded === true ? NO_WINDOW_NOTE : ''}`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to run Godot project: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the run_scene tool
   * @param args Tool arguments
   */
  private async handleRunScene(args: RunSceneArgs) {
    const { projectPath, scenePath } = args;
    const timeoutMs = args.timeoutMs ?? DEFAULT_SCENE_TIMEOUT_MS;

    if (!projectPath.trim()) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!scenePath.trim()) {
      return this.createErrorResponse(
        'Scene path is required',
        ['Provide a res:// scene path or a path relative to the project']
      );
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    if (!this.validatePath(scenePath) || isAbsolute(scenePath)) {
      return this.createErrorResponse(
        'Invalid scene path',
        ['Provide a res:// scene path or a path relative to the project without ".."']
      );
    }

    if (!/\.(tscn|scn)$/i.test(scenePath)) {
      return this.createErrorResponse(
        'scenePath must point to a Godot scene file',
        ['Provide a .tscn or .scn file']
      );
    }

    const userArgs = this.parseUserArgs(args.args);

    const embeddedProblem = this.embeddedOptionProblem(args.embedded, args.harness);
    if (embeddedProblem) {
      return this.createErrorResponse(embeddedProblem, ['Omit embedded to run the game in a normal window']);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      const projectRelativeScenePath = scenePath.startsWith('res://')
        ? scenePath.slice('res://'.length)
        : scenePath;
      const normalizedResourcePath = projectRelativeScenePath.split('\\').join('/');
      const sceneFile = join(projectPath, ...normalizedResourcePath.split('/'));
      if (!existsSync(sceneFile)) {
        return this.createErrorResponse(
          `Scene does not exist: ${scenePath}`,
          ['Ensure scenePath points to an existing scene in the project']
        );
      }

      const godotScenePath = `res://${normalizedResourcePath}`;
      this.logDebug(`Running Godot scene: ${godotScenePath} in project: ${projectPath}`);
      await this.startGodotProcess(`scene ${godotScenePath}`, {
        projectPath,
        scene: godotScenePath,
        args: userArgs,
        harness: args.harness !== false,
        embedded: args.embedded === true,
        timeoutMs,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Godot scene ${scenePath} started in debug mode. Use get_debug_output to see output or stop_project to stop it. The scene will stop automatically after ${timeoutMs} ms.${args.embedded === true ? NO_WINDOW_NOTE : ''}`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to run Godot scene: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project and scene paths are accessible',
        ]
      );
    }
  }

  /**
   * Return the game arguments of run_project and run_scene. A leading "--"
   * is dropped because startGodotProcess adds its own.
   */
  private parseUserArgs(value: string[] | undefined): string[] {
    if (value === undefined) {
      return [];
    }
    return value[0] === '--' ? value.slice(1) : [...value];
  }

  /**
   * Check the optional embedded parameter of run_project and run_scene.
   * Returns why it is refused, or null when it is fine.
   */
  private embeddedOptionProblem(embedded: boolean | undefined, harness: boolean | undefined): string | null {
    if (embedded && process.platform !== 'darwin') {
      return 'embedded only works on macOS';
    }
    if (embedded && harness === false) {
      return 'embedded needs the harness, because without it nothing can see or click the game';
    }
    return null;
  }

  /**
   * Feed a child process stream to onLine one line at a time. A chunk can end
   * in the middle of a line, so the unfinished tail waits for the next chunk,
   * and flush() hands it over when the stream ends.
   */
  private lineSplitter(onLine: (line: string) => void) {
    let partial = '';
    return {
      push: (chunk: Buffer) => {
        partial += chunk.toString();
        const lines = partial.split('\n');
        partial = lines.pop() ?? '';
        lines.forEach(onLine);
      },
      flush: () => {
        if (partial) {
          onLine(partial);
        }
        partial = '';
      },
    };
  }

  /**
   * Start a Godot process and capture its output for the debug tools.
   */
  private async startGodotProcess(
    description: string,
    options: StartProcessOptions
  ): Promise<void> {
    if (this.currentProcess?.isRunning) {
      this.logDebug('Killing existing Godot process before starting a new one');
      await this.stopCurrentProcess();
    }

    // Godot hands everything after "--" to the game, so the game's args go last.
    const spawnArgs = ['-d', '--path', options.projectPath];
    // Godot's embedded display server sends debugger messages while it starts,
    // so this mode relies on the -d above.
    if (options.embedded) {
      spawnArgs.push('--embedded');
    }
    const env = { ...process.env };
    let harness: GodotProcess['harness'];
    if (options.harness) {
      harness = { port: await this.pickFreePort(), token: randomBytes(16).toString('hex') };
      spawnArgs.push('-s', this.harnessScriptPath);
      env.GODOT_MCP_HARNESS_PORT = String(harness.port);
      env.GODOT_MCP_HARNESS_TOKEN = harness.token;
    }
    if (options.scene) {
      spawnArgs.push(options.scene);
    }
    if (options.args.length > 0) {
      spawnArgs.push('--', ...options.args);
    }

    const childProcess = spawn(this.godotPath!, spawnArgs, { stdio: 'pipe', env });
    const godotProcess: GodotProcess = {
      process: childProcess,
      description,
      projectPath: options.projectPath,
      scene: options.scene,
      args: options.args,
      output: [],
      errors: [],
      droppedOutputLines: 0,
      droppedErrorLines: 0,
      startedAt: new Date(),
      isRunning: true,
      harness,
    };
    this.currentProcess = godotProcess;

    const keepLine = (stream: 'stdout' | 'stderr') => (line: string) => {
      const cleaned = line.replace(/\r/g, '').trimEnd();
      if (!cleaned) {
        return;
      }
      const buffer = stream === 'stdout' ? godotProcess.output : godotProcess.errors;
      buffer.push(cleaned);
      if (buffer.length > OUTPUT_BUFFER_LIMIT) {
        buffer.shift();
        if (stream === 'stdout') {
          godotProcess.droppedOutputLines++;
        } else {
          godotProcess.droppedErrorLines++;
        }
      }
      this.logDebug(`[Godot ${stream}] ${cleaned}`);
    };
    const stdoutLines = this.lineSplitter(keepLine('stdout'));
    const stderrLines = this.lineSplitter(keepLine('stderr'));
    childProcess.stdout?.on('data', stdoutLines.push);
    childProcess.stderr?.on('data', stderrLines.push);

    childProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.logDebug(`Godot ${description} process exited with code ${code}`);
      if (godotProcess.timeout) {
        clearTimeout(godotProcess.timeout);
      }
      stdoutLines.flush();
      stderrLines.flush();
      godotProcess.isRunning = false;
      godotProcess.exitedAt = new Date();
      godotProcess.exitCode = code;
      godotProcess.exitSignal = signal;
    });

    childProcess.on('error', (err: Error) => {
      console.error(`Failed to start Godot ${description} process:`, err);
      if (godotProcess.timeout) {
        clearTimeout(godotProcess.timeout);
      }
      godotProcess.errors.push(`Process error: ${err.message}`);
      godotProcess.isRunning = false;
      godotProcess.exitedAt = new Date();
    });

    if (options.timeoutMs !== undefined) {
      godotProcess.timeout = setTimeout(() => {
        if (godotProcess.isRunning) {
          this.logDebug(`Stopping Godot ${description} process after ${options.timeoutMs} ms timeout`);
          godotProcess.stoppedByTimeout = true;
          childProcess.kill();
        }
      }, options.timeoutMs);
    }
  }

  /**
   * Stop the current Godot process and wait briefly for it to release resources.
   * The record stays in currentProcess so callers can still read its output.
   */
  private async stopCurrentProcess(): Promise<void> {
    const godotProcess = this.currentProcess;
    if (!godotProcess) {
      return;
    }

    if (godotProcess.timeout) {
      clearTimeout(godotProcess.timeout);
    }

    const childProcess = godotProcess.process;
    if (childProcess.exitCode === null && childProcess.signalCode === null) {
      await new Promise<void>((resolve) => {
        let settled = false;
        let waitTimeout: NodeJS.Timeout | undefined;

        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (waitTimeout) {
            clearTimeout(waitTimeout);
          }
          childProcess.removeListener('exit', finish);
          resolve();
        };

        waitTimeout = setTimeout(finish, PROCESS_EXIT_WAIT_MS);
        childProcess.once('exit', finish);

        try {
          if (!childProcess.kill()) {
            finish();
          }
        } catch {
          finish();
        }
      });
    }

    if (childProcess.exitCode === null && childProcess.signalCode === null) {
      this.logDebug(`Godot ${godotProcess.description} ignored SIGTERM, sending SIGKILL`);
      childProcess.kill('SIGKILL');
    }
  }

  /**
   * Describe a process record for get_debug_output and stop_project.
   */
  private describeProcess(godotProcess: GodotProcess) {
    return {
      running: godotProcess.isRunning,
      target: godotProcess.description,
      projectPath: godotProcess.projectPath,
      scene: godotProcess.scene,
      args: godotProcess.args,
      startedAt: godotProcess.startedAt.toISOString(),
      exitedAt: godotProcess.exitedAt?.toISOString(),
      exitCode: godotProcess.exitCode,
      exitSignal: godotProcess.exitSignal,
      stoppedByTimeout: godotProcess.stoppedByTimeout,
      droppedOutputLines: godotProcess.droppedOutputLines || undefined,
      droppedErrorLines: godotProcess.droppedErrorLines || undefined,
    };
  }

  /**
   * Handle the get_debug_output tool
   */
  private async handleGetDebugOutput() {
    if (!this.currentProcess) {
      return this.createErrorResponse(
        'No active Godot process.',
        [
          'Use run_project or run_scene to start a Godot process first',
          'stop_project clears the output of the process it stopped',
        ]
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ...this.describeProcess(this.currentProcess),
              output: this.currentProcess.output,
              errors: this.currentProcess.errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the stop_project tool
   */
  private async handleStopProject() {
    const godotProcess = this.currentProcess;
    if (!godotProcess) {
      return this.createErrorResponse(
        'No active Godot process to stop.',
        [
          'Use run_project or run_scene to start a Godot process first',
          'The process may have already terminated',
        ]
      );
    }

    const wasRunning = godotProcess.isRunning;
    if (wasRunning) {
      this.logDebug('Stopping running Godot process');
      await this.stopCurrentProcess();
    }
    this.currentProcess = null;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: wasRunning ? 'Godot project stopped' : 'Godot process had already exited',
              ...this.describeProcess(godotProcess),
              finalOutput: godotProcess.output,
              finalErrors: godotProcess.errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Ask the OS for a free loopback port by binding port 0. The port is
   * released before Godot binds it, which leaves a short window in which
   * another process could take it, and the harness then logs that it could
   * not listen.
   */
  private pickFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          const port = address.port;
          server.close(() => resolve(port));
        } else {
          server.close();
          reject(new Error('Failed to pick a free port'));
        }
      });
    });
  }

  /**
   * Send commands to mcp_harness.gd in the running game and return its answer.
   * Calls are queued so that two tool calls never interleave their commands.
   */
  private requestHarness(
    commands: object[],
    timeoutMs: number,
    options: Record<string, unknown> = {}
  ): Promise<HarnessResponse> {
    const run = () => this.sendHarnessRequest(commands, timeoutMs, options);
    const result = this.harnessQueue.then(run, run);
    this.harnessQueue = result.catch(() => undefined);
    return result;
  }

  private async sendHarnessRequest(
    commands: object[],
    timeoutMs: number,
    options: Record<string, unknown>
  ): Promise<HarnessResponse> {
    const godotProcess = this.currentProcess;
    if (!godotProcess?.isRunning) {
      throw new Error('No game is running. Start one with run_project or run_scene first.');
    }
    if (!godotProcess.harness) {
      throw new Error('The running game was started with harness: false. Start it again without that option.');
    }
    const payload = JSON.stringify({ ...options, token: godotProcess.harness.token, commands }) + '\n';
    const deadline = Date.now() + timeoutMs;
    // The harness starts listening only once the engine has booted, so a
    // refused connection right after run_project means "not yet".
    for (;;) {
      try {
        return await this.harnessExchange(godotProcess.harness.port, payload, deadline);
      } catch (error: any) {
        if (error?.code === 'ECONNREFUSED' && godotProcess.isRunning && Date.now() + 250 < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        throw error;
      }
    }
  }

  private harnessExchange(port: number, payload: string, deadline: number): Promise<HarnessResponse> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (error: Error | null, value?: HarnessResponse) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) {
          reject(error);
        } else {
          resolve(value!);
        }
      };
      const timer = setTimeout(() => {
        finish(new Error('The game did not answer in time. If get_debug_output ends at a "debug>" prompt, a script error has paused it.'));
      }, Math.max(1, deadline - Date.now()));
      socket.on('connect', () => socket.write(payload));
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (chunk.includes(10)) {
          const line = Buffer.concat(chunks).toString('utf8').split('\n')[0];
          try {
            finish(null, JSON.parse(line) as HarnessResponse);
          } catch {
            finish(new Error('The harness answered with something that is not JSON'));
          }
        }
      });
      socket.on('error', (error) => finish(error));
      socket.on('close', () => finish(new Error('The harness closed the connection without answering')));
    });
  }

  /**
   * Handle the capture_screenshot tool
   */
  private async handleCaptureScreenshot(args: CaptureScreenshotArgs) {
    if (args.savePath !== undefined) {
      if (
        !isAbsolute(args.savePath)
        || !args.savePath.toLowerCase().endsWith('.png')
        || !this.validatePath(args.savePath)
        || !existsSync(dirname(args.savePath))
      ) {
        return this.createErrorResponse('Invalid savePath', [
          'Use an absolute path ending in .png, without "..", in a directory that exists',
        ]);
      }
    }

    try {
      const response = await this.requestHarness([{ type: 'screenshot' }], 15000);
      const shot = response.results?.[0];
      if (!response.ok || !shot?.png_base64) {
        return this.createErrorResponse(
          `Screenshot failed: ${shot?.error ?? response.error ?? 'no image in the answer'}`,
          [
            'A game that runs headless draws nothing, so a screenshot needs a windowed run',
            'A minimized, hidden or covered window draws nothing either, so bring the game window to the front and try again',
          ]
        );
      }

      let saved = '';
      if (args.savePath) {
        writeFileSync(args.savePath, Buffer.from(shot.png_base64, 'base64'));
        saved = ` Also saved to ${args.savePath}.`;
      }
      return {
        content: [
          { type: 'image', data: shot.png_base64, mimeType: 'image/png' },
          {
            type: 'text',
            text: `Screenshot of the running game, ${shot.width}x${shot.height} px in viewport coordinates.${saved}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to capture screenshot: ${error?.message || 'Unknown error'}`, [
        'Start the game with run_project or run_scene first',
        'Check get_debug_output for "[godot-mcp harness] listening on" to confirm the harness started',
      ]);
    }
  }

  /**
   * Handle the simulate_input tool
   */
  private async handleSimulateInput(args: SimulateInputArgs) {
    const commands = args.commands;
    if (commands.length === 0) {
      return this.createErrorResponse('commands must be a non-empty list of objects that each have a type', [
        'For example [{"type": "click", "x": 480, "y": 260}]',
      ]);
    }
    const timeoutMs = args.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SCENE_TIMEOUT_MS) {
      return this.createErrorResponse(`timeoutMs must be an integer between 1 and ${MAX_SCENE_TIMEOUT_MS}`, [
        `Omit it to use ${DEFAULT_INPUT_TIMEOUT_MS}`,
      ]);
    }

    let response: HarnessResponse;
    try {
      response = await this.requestHarness(commands, timeoutMs, { warp_mouse: args.warpMouse === true });
    } catch (error: any) {
      return this.createErrorResponse(`Failed to send input: ${error?.message || 'Unknown error'}`, [
        'Start the game with run_project or run_scene first',
        'Raise timeoutMs when the commands wait longer than that in total',
      ]);
    }

    const results = response.results ?? [];
    const content: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = [];
    for (const result of results) {
      if (typeof result.png_base64 === 'string') {
        content.push({ type: 'image', data: result.png_base64, mimeType: 'image/png' });
      }
    }
    const screenshots = content.length;

    if (!response.ok) {
      const failedIndex = results.findIndex((result) => typeof result.error === 'string');
      let text: string;
      if (failedIndex === -1) {
        text = `The harness refused the request: ${response.error ?? 'no reason given'}.`;
      } else {
        const failed = results[failedIndex];
        text = `Command ${failedIndex + 1} of ${commands.length} (${failed.type || 'unknown'}) failed: ${failed.error}.`;
        if (failedIndex + 1 < commands.length) {
          text += ` Commands ${failedIndex + 2} to ${commands.length} did not run.`;
        }
      }
      content.push({ type: 'text', text });
      return { content, isError: true };
    }

    const shotText = screenshots > 0 ? ` The ${screenshots} screenshot(s) are in viewport coordinates.` : '';
    content.push({ type: 'text', text: `Ran ${commands.length} command(s).${shotText}` });
    return { content };
  }

  /**
   * Check a test or dir argument of run_gut_tests and return it as a list.
   * GUT splits list options on commas and cuts values at a second "=", so
   * entries containing either are refused instead of being misread.
   */
  private parseGutPathList(list: string[] | undefined, field: string): { paths: string[] } | { error: string } {
    if (list === undefined) {
      return { paths: [] };
    }
    for (const item of list) {
      if (
        !item.startsWith('res://')
        || !this.validatePath(item)
        || item.includes(',')
        || item.includes('=')
      ) {
        return { error: `${field} entries must be res:// paths without "..", "," or "="` };
      }
    }
    return { paths: list };
  }

  /**
   * Handle the run_gut_tests tool
   */
  private async handleRunGutTests(args: RunGutTestsArgs) {
    if (!args.projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    const tests = this.parseGutPathList(args.test, 'test');
    const dirs = this.parseGutPathList(args.dir, 'dir');
    if ('error' in tests || 'error' in dirs) {
      return this.createErrorResponse(
        'error' in tests ? tests.error : (dirs as { error: string }).error,
        ['Pass paths such as res://test/unit/test_player.gd or res://test/unit']
      );
    }

    for (const field of ['unitTestName', 'select', 'innerClass'] as const) {
      if (args[field]?.includes('=')) {
        return this.createErrorResponse(`${field} must be a string without "="`, [
          'GUT cuts option values at a second "="',
        ]);
      }
    }

    const timeoutMs = args.timeoutMs ?? DEFAULT_GUT_TIMEOUT_MS;

    if (this.gutProcess) {
      return this.createErrorResponse('A GUT run is already in progress', [
        'Wait for it to finish before starting another one',
      ]);
    }

    try {
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      if (!existsSync(join(args.projectPath, 'project.godot'))) {
        return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }
      if (!existsSync(join(args.projectPath, 'addons', 'gut', 'gut_cmdln.gd'))) {
        return this.createErrorResponse('GUT is not installed in this project', [
          'Install GUT so that res://addons/gut/gut_cmdln.gd exists',
        ]);
      }
      const hasGutConfig = existsSync(join(args.projectPath, '.gutconfig.json'));
      if (tests.paths.length === 0 && dirs.paths.length === 0 && !hasGutConfig) {
        return this.createErrorResponse('No tests to run', [
          'Pass test or dir, or add a .gutconfig.json that lists dirs',
        ]);
      }

      const cmdArgs: string[] = [];
      if (args.headless !== false) {
        cmdArgs.push('--headless');
      }
      cmdArgs.push('--path', args.projectPath, '-s', 'res://addons/gut/gut_cmdln.gd', '-gexit');
      if (tests.paths.length > 0) {
        cmdArgs.push(`-gtest=${tests.paths.join(',')}`);
      }
      if (dirs.paths.length > 0) {
        cmdArgs.push(`-gdir=${dirs.paths.join(',')}`);
      } else if (tests.paths.length > 0) {
        // -gtest adds to the .gutconfig.json dirs instead of replacing them,
        // so an empty -gdir= is what limits the run to the named scripts.
        cmdArgs.push('-gdir=');
      }
      if (args.includeSubdirs !== false) {
        cmdArgs.push('-ginclude_subdirs');
      }
      if (typeof args.log === 'number') cmdArgs.push(`-glog=${args.log}`);
      if (args.unitTestName) cmdArgs.push(`-gunit_test_name=${args.unitTestName}`);
      if (args.select) cmdArgs.push(`-gselect=${args.select}`);
      if (args.innerClass) cmdArgs.push(`-ginner_class=${args.innerClass}`);

      this.logDebug(`Running GUT with args: ${JSON.stringify(cmdArgs)}`);

      const child = spawn(this.godotPath!, cmdArgs, { stdio: 'pipe' });
      this.gutProcess = child;
      let stdoutBuf = '';
      let stderrBuf = '';
      let timedOut = false;

      const { exitCode, signal } = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGKILL');
            }
          }, PROCESS_EXIT_WAIT_MS);
        }, timeoutMs);
        child.stdout.on('data', (d: Buffer) => {
          stdoutBuf = (stdoutBuf + d.toString()).slice(-GUT_OUTPUT_LIMIT_CHARS);
        });
        child.stderr.on('data', (d: Buffer) => {
          stderrBuf = (stderrBuf + d.toString()).slice(-GUT_OUTPUT_LIMIT_CHARS);
        });
        child.on('error', (err: Error) => {
          stderrBuf += `\nProcess error: ${err.message}`;
          clearTimeout(timer);
          resolve({ exitCode: null, signal: null });
        });
        child.on('close', (code: number | null, closeSignal: NodeJS.Signals | null) => {
          clearTimeout(timer);
          resolve({ exitCode: code, signal: closeSignal });
        });
      });

      const out = stdoutBuf.trim();
      const err = stderrBuf.trim();
      const status = timedOut
        ? `GUT run timed out after ${timeoutMs} ms`
        : exitCode === 0
          ? 'GUT tests passed'
          : `GUT tests failed (exit code ${exitCode ?? signal})`;
      const text = `${status}\n\nCommand: godot ${cmdArgs.join(' ')}\n\nSTDOUT:\n${out || '(empty)'}\n\nSTDERR:\n${err || '(empty)'}`;

      // GUT exits non-zero when a test fails, and the engine prints warnings to
      // stderr even on a green run, so only the exit code decides the result.
      if (timedOut || exitCode !== 0) {
        return this.createErrorResponse(text, [
          'Review the output for failing assertions',
          'Pass test or unitTestName to narrow the run',
        ]);
      }
      return { content: [{ type: 'text', text }] };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(`Failed to run GUT tests: ${errorMessage}`, [
        'Ensure Godot and GUT are installed in the project',
        'Verify addons/gut/gut_cmdln.gd exists in the project',
      ]);
    } finally {
      this.gutProcess = null;
    }
  }

  /**
   * Handle the get_godot_version tool
   */
  private async handleGetGodotVersion() {
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      this.logDebug('Getting Godot version');
      const { stdout } = await execFileAsync(this.godotPath!, ['--version']);
      return {
        content: [
          {
            type: 'text',
            text: stdout.trim(),
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to get Godot version: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
        ]
      );
    }
  }

  /**
   * Handle the list_projects tool
   */
  private async handleListProjects(args: ListProjectsArgs) {
    if (!args.directory) {
      return this.createErrorResponse(
        'Directory is required',
        ['Provide a valid directory path to search for Godot projects']
      );
    }

    if (!this.validatePath(args.directory)) {
      return this.createErrorResponse(
        'Invalid directory path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      this.logDebug(`Listing Godot projects in directory: ${args.directory}`);
      if (!existsSync(args.directory)) {
        return this.createErrorResponse(
          `Directory does not exist: ${args.directory}`,
          ['Provide a valid directory path that exists on the system']
        );
      }

      const recursive = args.recursive === true;
      const projects = this.findGodotProjects(args.directory, recursive);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to list projects: ${error?.message || 'Unknown error'}`,
        [
          'Ensure the directory exists and is accessible',
          'Check if you have permission to read the directory',
        ]
      );
    }
  }

  /**
   * Get the structure of a Godot project asynchronously by counting files recursively
   * @param projectPath Path to the Godot project
   * @returns Promise resolving to an object with counts of scenes, scripts, assets, and other files
   */
  private getProjectStructureAsync(projectPath: string): Promise<any> {
    return new Promise((resolve) => {
      try {
        const structure = {
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0,
        };

        const scanDirectory = (currentPath: string) => {
          const entries = readdirSync(currentPath, { withFileTypes: true });
          
          for (const entry of entries) {
            const entryPath = join(currentPath, entry.name);
            
            // Skip hidden files and directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            
            if (entry.isDirectory()) {
              // Recursively scan subdirectories
              scanDirectory(entryPath);
            } else if (entry.isFile()) {
              // Count file by extension
              const ext = entry.name.split('.').pop()?.toLowerCase();
              
              if (ext === 'tscn') {
                structure.scenes++;
              } else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
                structure.scripts++;
              } else if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(ext || '')) {
                structure.assets++;
              } else {
                structure.other++;
              }
            }
          }
        };
        
        // Start scanning from the project root
        scanDirectory(projectPath);
        resolve(structure);
      } catch (error) {
        this.logDebug(`Error getting project structure asynchronously: ${error}`);
        resolve({ 
          error: 'Failed to get project structure',
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0
        });
      }
    });
  }

  /**
   * Handle the get_project_info tool
   */
  private async handleGetProjectInfo(args: GetProjectInfoArgs) {
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }
  
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }
  
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }
  
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }
  
      this.logDebug(`Getting project info for: ${args.projectPath}`);
  
      // Get Godot version
      const execOptions = { timeout: 10000 }; // 10 second timeout
      const { stdout } = await execFileAsync(this.godotPath!, ['--version'], execOptions);
  
      // Get project structure using the recursive method
      const projectStructure = await this.getProjectStructureAsync(args.projectPath);
  
      // Extract project name from project.godot file
      let projectName = basename(args.projectPath);
      try {
        const projectFileContent = readFileSync(projectFile, 'utf8');
        const configNameMatch = projectFileContent.match(/config\/name="([^"]+)"/);
        if (configNameMatch && configNameMatch[1]) {
          projectName = configNameMatch[1];
          this.logDebug(`Found project name in config: ${projectName}`);
        }
      } catch (error) {
        this.logDebug(`Error reading project file: ${error}`);
        // Continue with default project name if extraction fails
      }
  
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: projectName,
                path: args.projectPath,
                godotVersion: stdout.trim(),
                structure: projectStructure,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get project info: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the create_scene tool
   */
  private async handleCreateScene(args: CreateSceneArgs) {
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Project path and scene path are required',
        ['Provide valid paths for both the project and the scene']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    const rootNodeType = args.rootNodeType || 'Node2D';
    if (!this.validateClassName(rootNodeType)) {
      return this.createErrorResponse(
        'Invalid rootNodeType',
        ['rootNodeType must be a built-in Godot class name (no paths, no file extensions)']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        rootNodeType,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('create_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to create scene: ${stderr}`,
          [
            'Check if the root node type is valid',
            'Ensure you have write permissions to the scene path',
            'Verify the scene path is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Scene created successfully at: ${args.scenePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the add_node tool
   */
  private async handleAddNode(args: AddNodeArgs) {
    if (!args.projectPath || !args.scenePath || !args.nodeType || !args.nodeName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodeType, and nodeName']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    if (!this.validateClassName(args.nodeType)) {
      return this.createErrorResponse(
        'Invalid nodeType',
        ['nodeType must be a built-in Godot class name (no paths, no file extensions)']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = resolveResourcePath(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        nodeType: args.nodeType,
        nodeName: args.nodeName,
      };

      // Add optional parameters
      if (args.parentNodePath) {
        params.parentNodePath = args.parentNodePath;
      }

      if (args.properties) {
        for (const [key, value] of Object.entries(args.properties)) {
          if (typeof value === 'string' && value.startsWith('res://') && !this.validatePath(value)) {
            return this.createErrorResponse(
              `Invalid resource path for property '${key}'`,
              ['Use a res:// path inside the project without ".."']
            );
          }
        }
        params.properties = args.properties;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('add_node', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to add node: ${stderr}`,
          [
            'Check if the node type is valid',
            'Ensure the parent node path exists',
            'Verify the scene file is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Node '${args.nodeName}' of type '${args.nodeType}' added successfully to '${args.scenePath}'.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to add node: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the load_sprite tool
   */
  private async handleLoadSprite(args: LoadSpriteArgs) {
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.texturePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, and texturePath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.nodePath) ||
      !this.validatePath(args.texturePath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = resolveResourcePath(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Check if the texture file exists
      const texturePath = resolveResourcePath(args.projectPath, args.texturePath);
      if (!existsSync(texturePath)) {
        return this.createErrorResponse(
          `Texture file does not exist: ${args.texturePath}`,
          [
            'Ensure the texture path is correct',
            'Upload or create the texture file first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        texturePath: args.texturePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('load_sprite', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to load sprite: ${stderr}`,
          [
            'Check if the node path is correct',
            'Ensure the node is a Sprite2D, Sprite3D, or TextureRect',
            'Verify the texture file is a valid image format',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Sprite loaded successfully with texture: ${args.texturePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to load sprite: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the export_mesh_library tool
   */
  private async handleExportMeshLibrary(args: ExportMeshLibraryArgs) {
    if (!args.projectPath || !args.scenePath || !args.outputPath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, and outputPath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.outputPath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = resolveResourcePath(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        outputPath: args.outputPath,
      };

      // Add optional parameters
      if (args.meshItemNames) {
        params.meshItemNames = args.meshItemNames;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('export_mesh_library', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to export mesh library: ${stderr}`,
          [
            'Check if the scene contains valid 3D meshes',
            'Ensure the output path is valid',
            'Verify the scene file is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `MeshLibrary exported successfully to: ${args.outputPath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to export mesh library: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the save_scene tool
   */
  private async handleSaveScene(args: SaveSceneArgs) {
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and scenePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    // If newPath is provided, validate it
    if (args.newPath && !this.validatePath(args.newPath)) {
      return this.createErrorResponse(
        'Invalid new path',
        ['Provide a valid new path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = resolveResourcePath(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
      };

      // Add optional parameters
      if (args.newPath) {
        params.newPath = args.newPath;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('save_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to save scene: ${stderr}`,
          [
            'Check if the scene file is valid',
            'Ensure you have write permissions to the output path',
            'Verify the scene can be properly packed',
          ]
        );
      }

      const savePath = args.newPath || args.scenePath;
      return {
        content: [
          {
            type: 'text',
            text: `Scene saved successfully to: ${savePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to save scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the get_uid tool
   */
  private async handleGetUid(args: GetUidArgs) {
    if (!args.projectPath || !args.filePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and filePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.filePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the file exists
      const filePath = resolveResourcePath(args.projectPath, args.filePath);
      if (!existsSync(filePath)) {
        return this.createErrorResponse(
          `File does not exist: ${args.filePath}`,
          ['Ensure the file path is correct']
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        filePath: args.filePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('get_uid', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to get UID: ${stderr}`,
          [
            'Check if the file is a valid Godot resource',
            'Ensure the file path is correct',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `UID for ${args.filePath}: ${stdout.trim()}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get UID: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the view_log tool
   */
  private async handleViewLog(args: ViewLogArgs) {

    let lineCount = 50; // default
    if (args.lineCount !== undefined) {
      lineCount = Math.max(1, Math.min(1000, Math.floor(args.lineCount)));
    }

    const lines = this.editorLogLines.slice(-lineCount);

    return {
      content: [
        {
          type: 'text' as const,
          text: lines.length > 0 ? lines.join('\n') : '(no output captured yet)',
        },
      ],
    };
  }

  /**
   * Handle the update_project_uids tool
   */
  private async handleUpdateProjectUids(args: UpdateProjectUidsArgs) {
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Execute using the current project root inside Godot.
      // Passing the absolute host path through to resave_resources() breaks
      // because the Godot-side script prefixes non-resource paths with res://,
      // turning /mnt/... into malformed res:///mnt/....
      // Explicitly pass a resource-root path so the Godot-side operation stays
      // inside the active project context without tripping its empty-params check.
      const params = {
        projectPath: 'res://',
      };
      const { stdout, stderr } = await this.executeOperation('resave_resources', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to update project UIDs: ${stderr}`,
          [
            'Check if the project is valid',
            'Ensure you have write permissions to the project directory',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Project UIDs updated successfully.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to update project UIDs: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the quit_godot tool
   */
  private async handleQuitGodot() {
    if (!this.editorProcess) {
      return this.createErrorResponse(
        'No Godot editor process is currently tracked',
        ['The editor may have been closed already, or launch_editor was not used to start it']
      );
    }

    try {
      this.logDebug('Quitting Godot editor');
      this.editorProcess.kill();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to quit Godot editor: ${errorMessage}`,
        ['The process may have already exited']
      );
    } finally {
      this.editorProcess = null;
    }

    return {
      content: [
        {
          type: 'text',
          text: 'Godot editor closed successfully.',
        },
      ],
    };
  }

  /**
   * Run the MCP server
   */
  async run() {
    try {
      // Detect Godot path before starting the server
      await this.detectGodotPath();

      if (!this.godotPath) {
        console.error('[SERVER] Failed to find a valid Godot executable path');
        console.error('[SERVER] Please set GODOT_PATH environment variable or provide a valid path');
        process.exit(1);
      }

      // Check if the path is valid
      const isValid = await this.isValidGodotPath(this.godotPath);

      if (!isValid) {
        if (this.strictPathValidation) {
          // In strict mode, exit if the path is invalid
          console.error(`[SERVER] Invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] Please set a valid GODOT_PATH environment variable or provide a valid path');
          process.exit(1);
        } else {
          // In compatibility mode, warn but continue with the default path
          console.error(`[SERVER] Warning: Using potentially invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] This may cause issues when executing Godot commands');
          console.error('[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.');
        }
      }

      console.error(`[SERVER] Using Godot at: ${this.godotPath}`);

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Godot MCP server running on stdio');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SERVER] Failed to start:', errorMessage);
      process.exit(1);
    }
  }
}

// Create and run the server
const server = new GodotServer();
server.run().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to run server:', errorMessage);
  process.exit(1);
});
