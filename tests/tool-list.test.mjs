import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = join(process.cwd(), 'build', 'index.js');
const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'tool-list.json');

// The fixture holds the tools/list output from before the move to McpServer
// (issue #1). The Zod conversion adds $schema, leaves out an empty required
// list, always writes properties, and writes additionalProperties: {} for a
// loose object. None of these change which input the schema accepts, so both
// sides drop them before the comparison.
function normalizeSchema(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeSchema);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (key === '$schema') {
      continue;
    }
    const isEmptySchema = typeof value[key] === 'object' && value[key] !== null
      && Object.keys(value[key]).length === 0;
    if (key === 'additionalProperties' && isEmptySchema) {
      continue;
    }
    result[key] = normalizeSchema(value[key]);
  }
  if (result.type === 'object') {
    result.properties ??= {};
    result.required ??= [];
  }
  return result;
}

function normalizeTools(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: normalizeSchema(tool.inputSchema),
  }));
}

test('tools/list keeps the names, descriptions and input schemas in the fixture', async () => {
  const expected = JSON.parse(await readFile(fixturePath, 'utf8'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    stderr: 'ignore',
  });
  const client = new Client({ name: 'tool-list-test', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 20);
    assert.deepEqual(normalizeTools(tools), normalizeTools(expected));
  } finally {
    await client.close();
  }
});
