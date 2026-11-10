import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const directory = await mkdtemp(path.join(tmpdir(), 'accelo-mcp-scope-'));
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1';
process.env.ACCELO_CLIENT_ID = 'test-client';
process.env.ACCELO_CLIENT_SECRET = 'test-secret';
process.env.TOKEN_DB_PATH = path.join(directory, 'tokens.db');

const [{ scopedServer }, { default: db }] = await Promise.all([
  import('../src/mcp.js'),
  import('../src/db.js'),
]);

after(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

test('read-only registration withholds fabricated tools while full scope passes them through', () => {
  const registered = [];
  const server = { tool: (name) => registered.push(name), close() {} };
  const readOnly = scopedServer(server, 'read_only');
  readOnly.tool('list_activities');
  readOnly.tool('future_unclassified_tool');
  assert.deepEqual(registered, ['list_activities']);

  const full = scopedServer(server, 'full');
  full.tool('future_unclassified_tool');
  assert.deepEqual(registered, ['list_activities', 'future_unclassified_tool']);
});

test('read-only registration includes job discovery and detail tools', () => {
  const registered = [];
  const readOnly = scopedServer({ tool: (name) => registered.push(name) }, 'read_only');

  readOnly.tool('list_jobs');
  readOnly.tool('get_job');

  assert.deepEqual(registered, ['list_jobs', 'get_job']);
});
