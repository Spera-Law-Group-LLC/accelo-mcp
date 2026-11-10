import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const directory = await mkdtemp(path.join(tmpdir(), 'accelo-mcp-issues-'));
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1';
process.env.ACCELO_CLIENT_ID = 'test-client';
process.env.ACCELO_CLIENT_SECRET = randomBytes(24).toString('base64url');
process.env.TOKEN_DB_PATH = path.join(directory, 'tokens.db');

const [{ registerIssueTools }, { default: db }] = await Promise.all([
  import('../src/issues.js'),
  import('../src/db.js'),
]);

db.prepare('INSERT INTO accelo_tokens (subject, access_token, expires_at, created_at) VALUES (?,?,?,?)')
  .run('test-subject', randomBytes(24).toString('base64url'), Date.now() + 3600000, Date.now());

const tools = new Map();
registerIssueTools({
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
    date_logged: String(1700000000 + count - index),
  }));
}

function mockAccelo(t, rows, { rejectOrder = false } = {}) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    assert.ok(url.pathname.endsWith('/activities'));
    const query = url.searchParams;
    assert.ok(query.has('_page'));
    if (rejectOrder && query.get('_filters').includes('order_by_desc')) {
      return Response.json({ meta: { message: 'Unsupported order filter' } }, { status: 400 });
    }
    const limit = Math.min(100, Number(query.get('_limit')));
    const page = Number(query.get('_page'));
    return Response.json({ response: rows.slice(page * limit, (page + 1) * limit) });
  });
  return requests;
}

async function call(args) {
  return callTool('list_issue_activities', args);
}

async function callTool(name, args) {
  const tool = tools.get(name);
  for (const [key, schema] of Object.entries(tool.schema)) schema.parse(args[key]);
  return JSON.parse((await tool.handler(args)).content[0].text);
}

test('list_issue_activities retrieves >100 rows without gaps or duplicates on both paths', async (t) => {
  for (const rejectOrder of [false, true]) {
    await t.test(`rejectOrder=${rejectOrder}`, async (t) => {
      const rows = activities(305);
      const requests = mockAccelo(t, rows, { rejectOrder });
      const received = [];
      for (let page = 0; page < 4; page++) {
        const result = await call({ issue_id: '123', limit: 100, page });
        assert.equal(result.activities.length, page < 3 ? 100 : 5);
        assert.equal(result.has_more, page < 3);
        received.push(...result.activities);
      }
      assert.deepEqual(received, rows);
      assert.ok(requests.every((url) => url.searchParams.get('_limit') === '100'));
      const pages = ['0', '1', '1', '2', '2', '3', '3'];
      assert.deepEqual(requests.map((url) => url.searchParams.get('_page')),
        rejectOrder ? pages.flatMap((page) => [page, page]) : pages);
      for (let index = 0; index < requests.length; index++) {
        const expected = rejectOrder && index % 2 === 1
          ? 'against(issue(123))'
          : 'against(issue(123)),order_by_desc(date_logged)';
        assert.equal(requests[index].searchParams.get('_filters'), expected);
      }
    });
  }
});

test('omitting page and limit returns the first 50 activities with an explicit end signal', async (t) => {
  const rows = activities(50);
  const requests = mockAccelo(t, rows);
  const result = await call({ issue_id: '123' });
  assert.deepEqual(result, { activities: rows, has_more: false });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get('_page'), '0');
  assert.equal(requests[0].searchParams.get('_limit'), '100');
});

test('issue activities page 250 rows under the Accelo cap at limits 100 and 37', async (t) => {
  for (const limit of [100, 37]) {
    for (const rejectOrder of [false, true]) {
      await t.test(`limit=${limit}, rejectOrder=${rejectOrder}`, async (t) => {
        const rows = activities(250);
        mockAccelo(t, rows, { rejectOrder });
        const received = [];
        for (let page = 0; page <= Math.ceil(rows.length / limit); page++) {
          const result = await call({ issue_id: '123', limit, page });
          assert.deepEqual(result.activities, rows.slice(page * limit, (page + 1) * limit));
          assert.equal(result.has_more, (page + 1) * limit < rows.length);
          received.push(...result.activities);
        }
        assert.deepEqual(received, rows);
      });
    }
  }
});

test('lookahead handles empty, exact, partial, beyond-end, and realigned windows', async (t) => {
  for (const limit of [1, 2, 50, 100]) {
    for (const count of [0, 1, limit - 1, limit, limit + 1, 2 * limit, 2 * limit + 1]) {
      await t.test(`limit=${limit}, count=${count}`, async (t) => {
        const rows = activities(count);
        mockAccelo(t, rows);
        const received = [];
        for (let page = 0; page <= Math.ceil(count / limit); page++) {
          const result = await call({ issue_id: '123', limit, page });
          assert.deepEqual(result.activities, rows.slice(page * limit, (page + 1) * limit));
          assert.equal(result.has_more, count > (page + 1) * limit);
          received.push(...result.activities);
        }
        assert.deepEqual(received, rows);
      });
    }
  }
});

test('fallback sorts the returned window newest-first, including date_created fallback', async (t) => {
  const rows = [
    { id: '1', date_logged: '100' },
    { id: '2', date_created: '300' },
    { id: '3', date_logged: '200' },
    { id: '4', date_logged: '400' },
  ];
  mockAccelo(t, rows, { rejectOrder: true });
  const result = await call({ issue_id: '123', limit: 3 });
  assert.deepEqual(result.activities.map((row) => row.id), ['2', '3', '1']);
  assert.equal(result.has_more, true);
});

test('issue activity schema validates pages and documents how to continue', () => {
  const tool = tools.get('list_issue_activities');
  for (const page of [-1, 0.5, '1']) {
    assert.equal(tool.schema.page.safeParse(page).success, false);
  }
  assert.equal(tool.schema.page.safeParse(undefined).success, true);
  assert.equal(tool.schema.page.safeParse(0).success, true);
  assert.match(tool.description, /has_more/);
  assert.match(tool.description, /page \+ 1/);
});

function mockIssueReads(t, response) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    assert.ok(url.pathname.endsWith('/issues') || url.pathname.includes('/profiles/values'));
    return Response.json({ response });
  });
  return requests;
}

test('list_issues rejects records outside the structured company scope', async (t) => {
  mockIssueReads(t, [{
    id: '1',
    against_type: 'company',
    against_id: '999',
    date_created: '1700000000',
  }]);

  const result = await callTool('list_issues', {
    against_type: 'company',
    against_id: '321',
  });

  assert.deepEqual(result, { status: 'filter_not_applied', mismatch_count: 1 });
  assert.equal(Object.hasOwn(result, 'issues'), false);
});

test('list_issues labels raw-filter results as unverified', async (t) => {
  mockIssueReads(t, [{ id: '1', against_type: 'company', against_id: '999' }]);

  const result = await callTool('list_issues', { filters: 'status(open)' });

  assert.deepEqual(result, {
    issues: [{ id: '1', against_type: 'company', against_id: '999' }],
    scope_verified: false,
  });
});

test('issue profile values distinguish definition and value IDs and allow field selection', async (t) => {
  const requests = mockIssueReads(t, [
    { id: '9001', field_id: '62', field_name: 'Project Folder', field_type: 'hyperlink', value: 'https://drive.example/one' },
    { id: '9002', field_id: '63', field_name: 'Summary', field_type: 'text', value: 'summary' },
  ]);

  const values = await callTool('get_issue_profile_values', { issue_id: '321', field_id: '62' });

  assert.equal(values.length, 1);
  assert.equal(values[0].field_id, '62');
  assert.equal(values[0].value_id, '9001');
  assert.equal(values[0].id, '9001');
  assert.notEqual(values[0].field_id, values[0].value_id);
  assert.equal(requests[0].searchParams.get('_fields'), 'id,value,field_id,field_name,field_type');
});
