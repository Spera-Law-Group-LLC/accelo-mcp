import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const directory = await mkdtemp(path.join(tmpdir(), 'accelo-mcp-projects-'));
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1';
process.env.ACCELO_CLIENT_ID = 'test-client';
process.env.ACCELO_CLIENT_SECRET = randomBytes(24).toString('base64url');
process.env.TOKEN_DB_PATH = path.join(directory, 'tokens.db');

const [{ registerProjectTools }, { default: db }] = await Promise.all([
  import('../src/projects.js'),
  import('../src/db.js'),
]);

db.prepare('INSERT INTO accelo_tokens (subject, access_token, expires_at, created_at) VALUES (?,?,?,?)')
  .run('test-subject', randomBytes(24).toString('base64url'), Date.now() + 3600000, Date.now());

const tools = new Map();
registerProjectTools({
  tool(name, description, schema, handler) {
    tools.set(name, { description, schema, handler });
  },
}, 'test-subject');

after(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function activities(ids) {
  return ids.map((id) => ({
    id: String(id),
    subject: `Activity ${id}`,
    date_logged: String(1700000000 - id),
  }));
}

function mockAccelo(t, sources, { milestones = [], rejectOrder = false, failMilestone } = {}) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    if (url.pathname.endsWith('/jobs/123/milestones')) {
      const limit = Number(url.searchParams.get('_limit'));
      const page = Number(url.searchParams.get('_page'));
      assert.ok(url.searchParams.has('_page'));
      return Response.json({ response: milestones.slice(page * limit, (page + 1) * limit) });
    }

    assert.ok(url.pathname.endsWith('/activities'));
    const query = url.searchParams;
    const filters = query.get('_filters');
    const sourceMatch = filters.match(/against\((job|milestone)\(([^)]+)\)\)/);
    assert.ok(sourceMatch);
    const [, type, id] = sourceMatch;
    if (failMilestone === id) {
      return Response.json({ meta: { message: 'Synthetic upstream failure' } }, { status: 500 });
    }
    if (rejectOrder && filters.includes('order_by_desc')) {
      return Response.json({ meta: { message: 'Unsupported order filter' } }, { status: 400 });
    }
    const rows = sources[`${type}:${id}`] || [];
    const limit = Number(query.get('_limit'));
    const page = Number(query.get('_page'));
    assert.ok(query.has('_page'));
    return Response.json({ response: rows.slice(page * limit, (page + 1) * limit) });
  });
  return requests;
}

async function call(args) {
  const tool = tools.get('list_project_activities');
  for (const [key, schema] of Object.entries(tool.schema)) schema.parse(args[key]);
  return JSON.parse((await tool.handler(args)).content[0].text);
}

test('list_project_activities pages the deduped union without gaps or repeats', async (t) => {
  const allIds = Array.from({ length: 310 }, (_, id) => id);
  const sources = {
    'job:123': activities(Array.from({ length: 150 }, (_, id) => id)),
    'milestone:11': activities(Array.from({ length: 120 }, (_, id) => id + 100)),
    'milestone:12': activities(Array.from({ length: 90 }, (_, id) => id + 220)),
  };
  mockAccelo(t, sources, { milestones: [{ id: '11' }, { id: '12' }] });
  const received = [];

  for (let page = 0; page < 4; page++) {
    const result = await call({ job_id: '123', limit: 100, page });
    assert.equal(result.has_more, page < 3);
    received.push(...result.activities.map((activity) => Number(activity.id)));
  }

  assert.deepEqual(received, allIds);
  assert.equal(new Set(received).size, allIds.length);
});

test('a source beyond the page limit is reported as capped, and omitted page defaults to zero', async (t) => {
  const requests = mockAccelo(t, { 'job:123': activities(Array.from({ length: 120 }, (_, id) => id)) });
  const result = await call({ job_id: '123', limit: 50 });

  assert.equal(result.page, 0);
  assert.equal(result.activities.length, 50);
  assert.equal(result.has_more, true);
  assert.deepEqual(result.sources_capped, ['job(123)']);
  assert.equal(result.activities_gathered, 51);
  assert.equal(Object.hasOwn(result, 'total_before_limit'), false);
  assert.ok(requests.filter((url) => url.pathname.endsWith('/activities'))
    .every((url) => url.searchParams.get('_page') === '0'));
});

test('a failed milestone source is named and marks the result partial', async (t) => {
  mockAccelo(t, {
    'job:123': [],
    'milestone:11': [],
    'milestone:12': activities([1]),
  }, { milestones: [{ id: '11' }, { id: '12' }], failMilestone: '11' });

  const result = await call({ job_id: '123' });

  assert.equal(result.partial, true);
  assert.deepEqual(result.sources_failed, [{ source: 'milestone(11)', page: 0 }]);
  assert.deepEqual(result.activities.map((activity) => activity.id), ['1']);
});

test('order-filter fallback keeps the requested page and upstream limit', async (t) => {
  const requests = mockAccelo(t, {
    'job:123': activities(Array.from({ length: 230 }, (_, id) => id)),
  }, { rejectOrder: true });

  const result = await call({ job_id: '123', limit: 50, page: 1 });
  const activityRequests = requests.filter((url) => url.pathname.endsWith('/activities'));

  assert.deepEqual(result.activities.map((activity) => Number(activity.id)),
    Array.from({ length: 50 }, (_, index) => index + 50));
  assert.equal(result.has_more, true);
  assert.deepEqual(activityRequests.map((url) => url.searchParams.get('_page')), ['0', '0', '1', '1']);
  assert.ok(activityRequests.every((url) => url.searchParams.get('_limit') === '100'));
});

test('milestone listing continues past the first 100 rows', async (t) => {
  const milestones = Array.from({ length: 101 }, (_, index) => ({ id: String(index + 1) }));
  const requests = mockAccelo(t, {}, { milestones });

  const result = await call({ job_id: '123' });
  const milestoneRequests = requests.filter((url) => url.pathname.endsWith('/jobs/123/milestones'));

  assert.equal(result.milestones_scanned, 101);
  assert.deepEqual(milestoneRequests.map((url) => url.searchParams.get('_page')), ['0', '1']);
});
