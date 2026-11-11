import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = join(process.cwd(), 'build', 'index.js');

// ADR-0001 dropped the snake_case argument aliases, so project_path is an
// unknown key and the required projectPath is missing.
test('a snake_case alias for a required argument fails input validation', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'godot-mcp-alias-'));
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
    const result = await client.callTool({
      name: 'get_project_info',
      arguments: { project_path: projectPath },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Input validation error/);
  } finally {
    await client.close();
    await rm(projectPath, { recursive: true, force: true });
  }
});
