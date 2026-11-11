import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = join(process.cwd(), 'build', 'index.js');

async function withProject(callback) {
  const projectPath = await mkdtemp(join(tmpdir(), 'godot-mcp-input-'));
  await writeFile(join(projectPath, 'project.godot'), 'config_version=5\n', 'utf8');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, GODOT_PATH: process.execPath },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'input-validation-test', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    return await callback(client, projectPath);
  } finally {
    await client.close();
    await rm(projectPath, { recursive: true, force: true });
  }
}

// ADR-0001 dropped the snake_case argument aliases, so project_path is an
// unknown key and the required projectPath is missing.
test('a snake_case alias for a required argument fails input validation', async () => {
  await withProject(async (client, projectPath) => {
    const result = await client.callTool({
      name: 'get_project_info',
      arguments: { project_path: projectPath },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Input validation error/);
    assert.match(result.content[0].text, /projectPath/);
  });
});

test('a snake_case alias next to the camelCase argument is ignored', async () => {
  await withProject(async (client, projectPath) => {
    const result = await client.callTool({
      name: 'get_project_info',
      arguments: { projectPath, project_path: '/nope' },
    });
    assert.notEqual(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).name, basename(projectPath));
  });
});

test('an unknown top-level key is ignored and the call succeeds', async () => {
  await withProject(async (client, projectPath) => {
    const result = await client.callTool({
      name: 'get_project_info',
      arguments: { projectPath, extra: 1 },
    });
    assert.notEqual(result.isError, true);
  });
});

test('an unknown tool name returns an isError result that names the tool', async () => {
  await withProject(async (client) => {
    const result = await client.callTool({ name: 'nope', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Tool nope not found/);
  });
});

test('the server declares tools.listChanged in its capabilities', async () => {
  await withProject(async (client) => {
    assert.equal(client.getServerCapabilities()?.tools?.listChanged, true);
  });
});

test('an empty required path reaches the handler check', async () => {
  await withProject(async (client) => {
    const info = await client.callTool({ name: 'get_project_info', arguments: { projectPath: '' } });
    assert.equal(info.isError, true);
    assert.match(info.content[0].text, /Project path is required/);

    const list = await client.callTool({ name: 'list_projects', arguments: { directory: '' } });
    assert.equal(list.isError, true);
    assert.match(list.content[0].text, /Directory is required/);
  });
});

test('a projectPath with ".." is rejected', async () => {
  await withProject(async (client, projectPath) => {
    const result = await client.callTool({
      name: 'get_project_info',
      arguments: { projectPath: `${projectPath}/../${basename(projectPath)}` },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid project path/);
  });
});

test('simulate_input arguments out of range fail input validation', async () => {
  await withProject(async (client) => {
    const cases = [
      { commands: [] },
      { commands: [{ type: 'wait' }], timeoutMs: 1.5 },
      { commands: [{ type: 'wait', duration_ms: -1 }] },
      { commands: [{ type: 'jump' }] },
    ];
    for (const args of cases) {
      const result = await client.callTool({ name: 'simulate_input', arguments: args });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(result.content[0].text, /Input validation error/, JSON.stringify(args));
    }
  });
});

test('run_project rejects a scene that is not a project scene file', async () => {
  await withProject(async (client, projectPath) => {
    const cases = [
      ['--editor', /scene must point to a Godot scene file/],
      ['/tmp/outside.tscn', /Invalid scene path/],
      ['../outside.tscn', /Invalid scene path/],
    ];
    for (const [scene, message] of cases) {
      const result = await client.callTool({ name: 'run_project', arguments: { projectPath, scene } });
      assert.equal(result.isError, true, scene);
      assert.match(result.content[0].text, message, scene);
    }
  });
});
