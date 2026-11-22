import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repositoryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(repositoryPath, 'tests', 'fixtures', 'run-scene-project');
const godotPath = process.env.GODOT_PATH;
const skipReason = !godotPath || !existsSync(godotPath)
  ? 'Set GODOT_PATH to a Godot executable to run the integration test'
  : false;

function getText(result) {
  const textContent = result.content.find((item) => item.type === 'text');
  assert.ok(textContent, 'Expected an MCP text response');
  return textContent.text;
}

function connectClient(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repositoryPath, 'build', 'index.js')],
    env: { ...process.env, GODOT_PATH: godotPath, ...env },
  });
  const client = new Client(
    { name: 'run-scene-integration-test', version: '1.0.0' },
    { capabilities: {} }
  );
  return { client, transport };
}

async function waitForDebugOutput(client, marker) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = await client.callTool({ name: 'get_debug_output', arguments: {} });
    const text = getText(result);
    if (text.includes(marker)) {
      return text;
    }
  }

  assert.fail(`Timed out waiting for debug marker: ${marker}`);
}

test('run_scene integrates with process and debug tools', {
  skip: skipReason,
  timeout: 60000,
}, async () => {
  const { client, transport } = connectClient();

  try {
    await client.connect(transport);

    const listedTools = await client.listTools();
    const runSceneTool = listedTools.tools.find((tool) => tool.name === 'run_scene');
    assert.ok(runSceneTool, 'run_scene should be exposed by tools/list');
    assert.deepEqual(runSceneTool.inputSchema.required, ['projectPath', 'scenePath']);
    assert.equal(runSceneTool.inputSchema.properties.timeoutMs.default, undefined);

    const invalidTimeout = await client.callTool({
      name: 'run_scene',
      arguments: {
        projectPath: fixturePath,
        scenePath: 'res://tests/smoke_test.tscn',
        timeoutMs: 2147483648,
      },
    });
    assert.equal(invalidTimeout.isError, true);
    assert.match(getText(invalidTimeout), /Input validation error: Invalid arguments for tool run_scene/);

    const missingScene = await client.callTool({
      name: 'run_scene',
      arguments: {
        projectPath: fixturePath,
        scenePath: 'res://tests/missing.tscn',
      },
    });
    assert.match(getText(missingScene), /Scene does not exist/);

    const startedScene = await client.callTool({
      name: 'run_scene',
      arguments: {
        projectPath: fixturePath,
        scenePath: 'tests/smoke_test.tscn',
      },
    });
    assert.match(getText(startedScene), /Godot scene tests\/smoke_test\.tscn started/);
    assert.match(getText(startedScene), /after 30000 ms/);
    assert.match(await waitForDebugOutput(client, 'RUN_SCENE_TEST_OK'), /RUN_SCENE_TEST_OK/);

    const replacedWithProject = await client.callTool({
      name: 'run_project',
      arguments: {
        projectPath: fixturePath,
        scene: 'res://tests/smoke_test.tscn',
      },
    });
    assert.match(getText(replacedWithProject), /Godot project started/);
    assert.match(await waitForDebugOutput(client, 'RUN_SCENE_TEST_OK'), /RUN_SCENE_TEST_OK/);

    const stoppedProject = await client.callTool({ name: 'stop_project', arguments: {} });
    assert.match(getText(stoppedProject), /Godot project stopped/);

    await client.callTool({
      name: 'run_scene',
      arguments: {
        projectPath: fixturePath,
        scenePath: 'res://tests/smoke_test.tscn',
        timeoutMs: 3000,
        args: ['--battle=1009'],
      },
    });
    let afterTimeout;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      afterTimeout = JSON.parse(getText(await client.callTool({ name: 'get_debug_output', arguments: {} })));
      if (!afterTimeout.running) {
        break;
      }
    }
    assert.equal(afterTimeout.running, false);
    assert.equal(afterTimeout.stoppedByTimeout, true);
    assert.ok(afterTimeout.output.includes('RUN_SCENE_TEST_OK'));
    assert.ok(afterTimeout.output.includes('RUN_SCENE_USER_ARGS ["--battle=1009"]'));

    const stoppedAfterExit = await client.callTool({ name: 'stop_project', arguments: {} });
    assert.match(getText(stoppedAfterExit), /already exited/);
    const afterStop = await client.callTool({ name: 'get_debug_output', arguments: {} });
    assert.match(getText(afterStop), /No active Godot process/);
  } finally {
    try {
      await client.callTool({ name: 'stop_project', arguments: {} });
    } catch {
      // The process may already be stopped or the transport may already be closed.
    }
    await client.close();
  }
});

test('inspect_node and inspect_tree read nodes of the running scene', {
  skip: skipReason,
  timeout: 60000,
}, async () => {
  const { client, transport } = connectClient();
  const inspectNode = (args) => client.callTool({ name: 'inspect_node', arguments: args });
  const readNode = async (args) => {
    const result = await inspectNode(args);
    assert.notEqual(result.isError, true, getText(result));
    return JSON.parse(getText(result));
  };
  const inspectTree = async (args) => {
    const result = await client.callTool({ name: 'inspect_tree', arguments: args });
    assert.notEqual(result.isError, true, getText(result));
    return JSON.parse(getText(result));
  };

  try {
    await client.connect(transport);
    await client.callTool({
      name: 'run_scene',
      arguments: { projectPath: fixturePath, scenePath: 'res://tests/smoke_test.tscn' },
    });
    await waitForDebugOutput(client, 'RUN_SCENE_TEST_OK');

    const labelInfo = await readNode({ path: 'VisibleLabel', props: ['name'] });
    assert.equal(labelInfo.path, '/root/SmokeTest/VisibleLabel');
    assert.equal(labelInfo.class, 'Label');
    assert.equal(labelInfo.visible, true);
    assert.deepEqual(labelInfo.rect, [10, 20, 100, 30]);
    assert.deepEqual(labelInfo.center, [60, 35]);
    assert.equal(labelInfo.text, 'Hello');
    assert.equal(labelInfo.props.name, '&"VisibleLabel"');

    const marker = await readNode({ path: '/root/SmokeTest/Marker' });
    assert.equal(marker.class, 'Node2D');
    assert.deepEqual(marker.position, [40, 50]);
    assert.equal('rect' in marker, false);
    assert.equal('props' in marker, false);

    // The scene has a CloseButton in a hidden panel first and one in a shown
    // panel second, so a bare name has to skip the hidden one.
    const closeButton = await readNode({ path: 'CloseButton' });
    assert.equal(closeButton.path, '/root/SmokeTest/ShownPanel/CloseButton');
    assert.equal(closeButton.visible, true);

    const hiddenButton = await readNode({ path: 'HiddenPanel/CloseButton' });
    assert.equal(hiddenButton.visible, false);

    // The CanvasLayer offset of (30, 40) moves where its children are drawn,
    // so the answer has to include it to be a point that click can use.
    const layerLabel = await readNode({ path: 'LayerLabel' });
    assert.deepEqual(layerLabel.rect, [40, 60, 100, 30]);
    assert.deepEqual(layerLabel.center, [90, 75]);
    const layerMarker = await readNode({ path: 'LayerMarker' });
    assert.deepEqual(layerMarker.position, [35, 45]);

    const missing = await inspectNode({ path: 'NoSuchNode' });
    assert.equal(missing.isError, true);
    assert.match(getText(missing), /no node NoSuchNode in the scene res:\/\/tests\/smoke_test\.tscn/);

    const tree = await inspectTree({});
    assert.equal(tree.scene, 'res://tests/smoke_test.tscn');
    assert.equal(tree.root, '/root/SmokeTest');
    assert.deepEqual(tree.nodes[0], { path: '/root/SmokeTest', class: 'Node', depth: 0 });
    const treeLabel = tree.nodes.find((node) => node.path === '/root/SmokeTest/VisibleLabel');
    const { props: _labelProps, ...labelKeys } = labelInfo;
    assert.deepEqual(treeLabel, { ...labelKeys, depth: 1 });
    const treePaths = tree.nodes.map((node) => node.path);
    assert.equal(treePaths.includes('/root/SmokeTest/HiddenPanel'), false);
    assert.equal(treePaths.includes('/root/SmokeTest/HiddenPanel/HiddenLabel'), false);

    const fullTree = await inspectTree({ includeHidden: true });
    const fullPaths = fullTree.nodes.map((node) => node.path);
    assert.ok(fullPaths.includes('/root/SmokeTest/HiddenPanel'));
    assert.ok(fullPaths.includes('/root/SmokeTest/HiddenPanel/HiddenLabel'));

    const panel = await inspectTree({ path: 'ShownPanel', depth: 0 });
    assert.deepEqual(panel.nodes.map((node) => node.path), ['/root/SmokeTest/ShownPanel']);
    const panelChildren = await inspectTree({ path: 'ShownPanel' });
    assert.deepEqual(panelChildren.nodes.map((node) => [node.path, node.depth]), [
      ['/root/SmokeTest/ShownPanel', 0],
      ['/root/SmokeTest/ShownPanel/CloseButton', 1],
    ]);

    const missingTree = await client.callTool({ name: 'inspect_tree', arguments: { path: 'NoSuchNode' } });
    assert.equal(missingTree.isError, true);
    assert.match(getText(missingTree), /no node NoSuchNode in the scene/);
  } finally {
    try {
      await client.callTool({ name: 'stop_project', arguments: {} });
    } catch {
      // The process may already be stopped or the transport may already be closed.
    }
    await client.close();
  }
});

test('GODOT_MCP_HARNESS_TITLE sets the window title of the running game', {
  skip: skipReason,
  timeout: 60000,
}, async () => {
  const readTitle = async (env) => {
    const { client, transport } = connectClient(env);
    try {
      await client.connect(transport);
      await client.callTool({
        name: 'run_scene',
        arguments: { projectPath: fixturePath, scenePath: 'res://tests/smoke_test.tscn' },
      });
      await waitForDebugOutput(client, 'RUN_SCENE_TEST_OK');
      const result = await client.callTool({ name: 'inspect_node', arguments: { path: '/root', props: ['title'] } });
      assert.notEqual(result.isError, true, getText(result));
      return JSON.parse(getText(result)).props.title;
    } finally {
      try {
        await client.callTool({ name: 'stop_project', arguments: {} });
      } catch {
        // The process may already be stopped or the transport may already be closed.
      }
      await client.close();
    }
  };

  assert.equal(await readTitle({ GODOT_MCP_HARNESS_TITLE: 'AGENT VERIFY - test' }), '"AGENT VERIFY - test"');
  // An empty variable counts as unset, so the title stays the project's name.
  assert.equal(await readTitle({ GODOT_MCP_HARNESS_TITLE: '' }), '"Run Scene MCP Test"');
});

test('run_scene with embedded runs a game with no window', {
  skip: skipReason || (process.platform !== 'darwin' ? 'embedded only works on macOS' : false),
  timeout: 60000,
}, async () => {
  const { client, transport } = connectClient();
  const scene = { projectPath: fixturePath, scenePath: 'res://tests/smoke_test.tscn' };

  try {
    await client.connect(transport);

    const invalidEmbedded = await client.callTool({ name: 'run_scene', arguments: { ...scene, embedded: 'yes' } });
    assert.equal(invalidEmbedded.isError, true);
    assert.match(getText(invalidEmbedded), /Input validation error: Invalid arguments for tool run_scene/);

    const withoutHarness = await client.callTool({ name: 'run_scene', arguments: { ...scene, embedded: true, harness: false } });
    assert.match(getText(withoutHarness), /embedded needs the harness/);

    const started = await client.callTool({ name: 'run_scene', arguments: { ...scene, embedded: true } });
    assert.match(getText(started), /no window/);
    await waitForDebugOutput(client, 'RUN_SCENE_DISPLAY embedded');
    await waitForDebugOutput(client, 'listening on');

    const screenshot = await client.callTool({ name: 'capture_screenshot', arguments: {} });
    assert.ok(screenshot.content.some((item) => item.type === 'image'), getText(screenshot));
  } finally {
    try {
      await client.callTool({ name: 'stop_project', arguments: {} });
    } catch {
      // The process may already be stopped or the transport may already be closed.
    }
    await client.close();
  }
});
