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

const [{ scopedServer }, { default: db }, { acceloGet }] = await Promise.all([
  import('../src/mcp.js'),
  import('../src/db.js'),
  import('../src/accelo.js'),
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

for (const scope of ['full', 'read_only']) {
  test(`${scope} tool handlers share a 20-second retry budget`, async (t) => {
    const delays = [];
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
      delays.push(delay);
      queueMicrotask(callback);
      return 0;
    });
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ meta: { message: 'rate limited' } }, {
        status: 429,
        headers: { 'Retry-After': '15' },
      }));

    let handler;
    const server = {
      tool(name, ...args) {
        handler = args.at(-1);
        return name;
      },
    };
    const scoped = scopedServer(server, scope);
    scoped.tool('list_activities', 'test tool', {}, async () => {
      await acceloGet('token', '/first');
      await acceloGet('token', '/second');
    });

    await assert.rejects(handler(), { status: 429 });
    assert.deepEqual(delays, [15000, 5000]);
  });
}
