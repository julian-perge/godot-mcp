import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = join(process.cwd(), 'build', 'index.js');

// This script stands in for Godot. It answers the --version check, and for any
// other call it writes one argument per line to the file in FAKE_GODOT_ARGV, so
// the test can read the JSON parameters that the server sends to godot_operations.gd.
const fakeGodot = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "4.4.stable.fake"
  exit 0
fi
printf '%s\\n' "$@" > "$FAKE_GODOT_ARGV"
`;

async function callWithFakeGodot(name, buildArguments) {
  const root = await mkdtemp(join(tmpdir(), 'godot-mcp-operation-'));
  const godotPath = join(root, 'godot');
  const argvPath = join(root, 'argv.txt');
  const projectPath = join(root, 'project');
  await writeFile(godotPath, fakeGodot, 'utf8');
  await chmod(godotPath, 0o755);
  await mkdir(projectPath);
  await writeFile(join(projectPath, 'project.godot'), 'config_version=5\n', 'utf8');
  await writeFile(join(projectPath, 'main.tscn'), '[gd_scene format=3]\n', 'utf8');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, GODOT_PATH: godotPath, FAKE_GODOT_ARGV: argvPath },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'operation-params-test', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: buildArguments(projectPath) });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    const argv = (await readFile(argvPath, 'utf8')).trimEnd().split('\n');
    const operationIndex = argv.indexOf(name);
    assert.notEqual(operationIndex, -1, argv.join(' '));
    return JSON.parse(argv[operationIndex + 1]);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('add_node sends snake_case parameters and passes properties keys through', async () => {
  const params = await callWithFakeGodot('add_node', (projectPath) => ({
    projectPath,
    scenePath: 'main.tscn',
    parentNodePath: 'root',
    nodeType: 'Sprite2D',
    nodeName: 'Player',
    properties: { zIndex: 3, position: { x: 1, y: 2 }, visible: false },
  }));

  assert.deepEqual(params, {
    scene_path: 'main.tscn',
    node_type: 'Sprite2D',
    node_name: 'Player',
    parent_node_path: 'root',
    properties: { z_index: 3, position: { x: 1, y: 2 }, visible: false },
  });
});

test('save_scene sends newPath as new_path', async () => {
  const params = await callWithFakeGodot('save_scene', (projectPath) => ({
    projectPath,
    scenePath: 'main.tscn',
    newPath: 'variant.tscn',
  }));

  assert.deepEqual(params, { scene_path: 'main.tscn', new_path: 'variant.tscn' });
});
