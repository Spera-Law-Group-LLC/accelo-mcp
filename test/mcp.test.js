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

const [{ buildServer, scopedServer }, { default: db }, { acceloGet }] = await Promise.all([
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
  readOnly.tool('get_accelo_guide');
  readOnly.tool('future_unclassified_tool');
  assert.deepEqual(registered, ['list_activities', 'get_accelo_guide']);

  const full = scopedServer(server, 'full');
  full.tool('future_unclassified_tool');
  assert.deepEqual(registered, ['list_activities', 'get_accelo_guide', 'future_unclassified_tool']);
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

test('read-only server registers the guide and structured quote filters', async (t) => {
  const server = buildServer('filter-subject', 'read_only');
  const tools = server._registeredTools;
  assert.ok(tools.get_accelo_guide);

  const guide = await tools.get_accelo_guide.handler({});
  assert.ok(guide.content[0].text.includes('GET /activities does not honor _search'));
  assert.match(guide.content[0].text, /against_type and against_id/);

  db.prepare('INSERT INTO accelo_tokens (subject, access_token, expires_at, created_at) VALUES (?,?,?,?)')
    .run('filter-subject', 'mcp-test-token', Date.now() + 3600000, Date.now());
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    requests.push(new URL(input));
    return Response.json({ meta: { status: 'ok' }, response: [] });
  });
  await tools.list_quotes.handler({ filter: { standing: 'active' } });
  assert.equal(requests[0].searchParams.get('_filters'), 'standing(active)');

  const conflict = await tools.list_quotes.handler({
    filter: { standing: 'active' },
    filters: 'status(open)',
  });
  assert.deepEqual(JSON.parse(conflict.content[0].text), {
    status: 'error',
    message: 'Provide either filter or filters, not both.',
  });
  assert.equal(requests.length, 1);
  await server.close();
});
