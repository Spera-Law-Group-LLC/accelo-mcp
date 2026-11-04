import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const directory = await mkdtemp(path.join(tmpdir(), 'accelo-mcp-activities-'));
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1';
process.env.ACCELO_CLIENT_ID = 'test-client';
process.env.ACCELO_CLIENT_SECRET = randomBytes(24).toString('base64url');
process.env.TOKEN_DB_PATH = path.join(directory, 'tokens.db');

const [{ registerActivityTools }, { default: db }] = await Promise.all([
  import('../src/activities.js'),
  import('../src/db.js'),
]);

db.prepare('INSERT INTO accelo_tokens (subject, access_token, expires_at, created_at) VALUES (?,?,?,?)')
  .run('test-subject', randomBytes(24).toString('base64url'), Date.now() + 3600000, Date.now());

const tools = new Map();
registerActivityTools({
  tool(name, description, schema, handler) {
    tools.set(name, { description, schema, handler });
  },
}, 'test-subject');

after(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function activities(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: String(count - index),
    subject: 'Synthetic activity',
    body: 'Synthetic body',
    html_body: '<p>Synthetic body</p>',
    medium: 'email',
    date_logged: String(1700000000 + count - index),
  }));
}

function mockAccelo(t, rows, { rejectOrder = false } = {}) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    if (url.pathname.endsWith('/activities/1')) {
      return Response.json({ response: { id: '1', thread_id: '7' } });
    }
    assert.ok(url.pathname.endsWith('/activities'));
    const query = url.searchParams;
    if (rejectOrder && query.get('_filters').includes('order_by_desc')) {
      return Response.json({ meta: { message: 'Unsupported order filter' } }, { status: 400 });
    }
    // Model Accelo pages using the requested size, not the caller's limit.
    const limit = Number(query.get('_limit'));
    const page = Number(query.get('_page'));
    assert.ok(query.has('_page'));
    return Response.json({ response: rows.slice(page * limit, (page + 1) * limit) });
  });
  return requests;
}

async function call(name, args) {
  const tool = tools.get(name);
  for (const [key, schema] of Object.entries(tool.schema)) schema.parse(args[key]);
  return JSON.parse((await tool.handler(args)).content[0].text);
}

test('list_activities retrieves a >100-row history without gaps or duplicates', async (t) => {
  const rows = activities(305);
  const requests = mockAccelo(t, rows);
  const received = [];
  for (let page = 0; page < 4; page++) {
    const result = await call('list_activities', {
      against_type: 'job', against_id: '123', medium: 'email', limit: 100, page,
    });
    assert.equal(result.activities.length, page < 3 ? 100 : 5);
    assert.equal(result.has_more, page < 3);
    assert.ok(result.activities.every((row) => row.html_body === undefined));
    received.push(...result.activities.map((row) => row.id));
  }
  assert.deepEqual(received, rows.map((row) => row.id));
  assert.ok(requests.every((url) => url.searchParams.get('_limit') === '101'));
  assert.ok(requests.every((url) =>
    url.searchParams.get('_filters') === 'against(job(123)),medium(email),order_by_desc(date_logged)'));
});

test('list_activities defaults to page zero and limit 50, with an explicit end signal', async (t) => {
  const requests = mockAccelo(t, activities(50));
  const result = await call('list_activities', { against_type: 'issue', against_id: '123' });
  assert.equal(result.activities.length, 50);
  assert.equal(result.has_more, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get('_page'), '0');
  assert.equal(requests[0].searchParams.get('_limit'), '51');
});

test('lookahead distinguishes exact, partial, empty, and beyond-end pages', async (t) => {
  for (const count of [0, 1, 49, 50, 51, 100, 101, 102]) {
    await t.test(`${count} activities`, async (t) => {
      const rows = activities(count);
      mockAccelo(t, rows);
      const received = [];
      for (let page = 0; page <= Math.ceil(count / 50); page++) {
        const result = await call('list_activities', {
          against_type: 'job', against_id: '123', limit: 50, page,
        });
        assert.deepEqual(result.activities.map((row) => row.id),
          rows.slice(page * 50, (page + 1) * 50).map((row) => row.id));
        assert.equal(result.has_more, count > (page + 1) * 50);
        received.push(...result.activities.map((row) => row.id));
      }
      assert.deepEqual(received, rows.map((row) => row.id));
    });
  }
});

test('order-filter fallback preserves _page and _limit on every upstream page', async (t) => {
  const rows = activities(305);
  const requests = mockAccelo(t, rows, { rejectOrder: true });
  const result = await call('list_activities', {
    against_type: 'job', against_id: '123', medium: 'email', limit: 100, page: 2,
  });
  assert.deepEqual(result.activities.map((row) => row.id), rows.slice(200, 300).map((row) => row.id));
  assert.equal(result.has_more, true);
  assert.deepEqual(requests.map((url) => url.searchParams.get('_page')), ['1', '1', '2', '2']);
  assert.ok(requests.every((url) => url.searchParams.get('_limit') === '101'));
  for (let index = 0; index < requests.length; index += 2) {
    assert.ok(requests[index].searchParams.get('_filters').includes('order_by_desc'));
    assert.equal(requests[index + 1].searchParams.get('_filters'), 'against(job(123)),medium(email)');
  }
});

test('get_activity_thread defaults to 100 and retrieves the remaining thread pages', async (t) => {
  const rows = activities(205);
  const requests = mockAccelo(t, rows);
  const received = [];
  for (let page = 0; page < 3; page++) {
    const result = await call('get_activity_thread', page === 0 ? { id: '1' } : { id: '1', page });
    assert.equal(result.thread_id, '7');
    assert.equal(result.activities.length, page < 2 ? 100 : 5);
    assert.equal(result.has_more, page < 2);
    received.push(...result.activities.map((row) => row.id));
  }
  assert.deepEqual(received, rows.map((row) => row.id));
  const listRequests = requests.filter((url) => url.pathname.endsWith('/activities'));
  assert.ok(listRequests.every((url) => url.searchParams.get('_limit') === '101'));
  assert.ok(listRequests.every((url) => url.searchParams.get('_filters') === 'thread(7),order_by_desc(date_logged)'));
  assert.equal(listRequests[0].searchParams.get('_page'), '0');
});

test('get_activity_thread honors a smaller caller limit and uses the order fallback', async (t) => {
  const requests = mockAccelo(t, activities(5), { rejectOrder: true });
  const result = await call('get_activity_thread', { id: '1', limit: 2, page: 1 });
  assert.deepEqual(result.activities.map((row) => row.id), ['3', '2']);
  assert.equal(result.has_more, true);
  const listRequests = requests.filter((url) => url.pathname.endsWith('/activities'));
  assert.deepEqual(listRequests.map((url) => url.searchParams.get('_page')), ['0', '0', '1', '1']);
  assert.ok(listRequests.every((url) => url.searchParams.get('_limit') === '3'));
});

test('activity read schemas reject invalid pages and explain how to follow has_more', () => {
  for (const name of ['list_activities', 'get_activity_thread']) {
    const tool = tools.get(name);
    for (const page of [-1, 0.5, '1']) {
      assert.equal(tool.schema.page.safeParse(page).success, false);
    }
    assert.equal(tool.schema.page.safeParse(undefined).success, true);
    assert.equal(tool.schema.page.safeParse(0).success, true);
    assert.match(tool.description, /has_more/);
    assert.match(tool.description, /page \+ 1/);
  }
});
