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
    // Accelo caps the effective page size at 100.
    const limit = Math.min(100, Number(query.get('_limit')));
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

function mockActivityWrite(t, parent = { id: 'parent-id', against_type: 'job', against_id: '123' }) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    requests.push({ url, options });
    if (url.pathname.endsWith('/activities/parent-id')) {
      return Response.json({ response: parent });
    }
    if (url.pathname.endsWith('/activities') && options.method === 'POST') {
      return Response.json({ response: { id: 'created-id' } });
    }
    if (url.pathname.endsWith('/activities/created-id')) {
      return Response.json({
        response: { id: 'created-id', ...Object.fromEntries(new URLSearchParams(options.body || '')) },
      });
    }
    throw new Error(`Unexpected Accelo request: ${options.method || 'GET'} ${url.pathname}`);
  });
  return requests;
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
  assert.ok(requests.every((url) => url.searchParams.get('_limit') === '100'));
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
  assert.equal(requests[0].searchParams.get('_limit'), '100');
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
  assert.deepEqual(requests.map((url) => url.searchParams.get('_page')), ['2', '2', '3', '3']);
  assert.ok(requests.every((url) => url.searchParams.get('_limit') === '100'));
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
  assert.ok(listRequests.every((url) => url.searchParams.get('_limit') === '100'));
  assert.ok(listRequests.every((url) => url.searchParams.get('_filters') === 'thread(7),order_by_desc(date_logged)'));
  assert.equal(listRequests[0].searchParams.get('_page'), '0');
});

test('get_activity_thread honors a smaller caller limit and uses the order fallback', async (t) => {
  const requests = mockAccelo(t, activities(5), { rejectOrder: true });
  const result = await call('get_activity_thread', { id: '1', limit: 2, page: 1 });
  assert.deepEqual(result.activities.map((row) => row.id), ['3', '2']);
  assert.equal(result.has_more, true);
  const listRequests = requests.filter((url) => url.pathname.endsWith('/activities'));
  assert.deepEqual(listRequests.map((url) => url.searchParams.get('_page')), ['0', '0']);
  assert.ok(listRequests.every((url) => url.searchParams.get('_limit') === '100'));
});

test('activity reads page 250 rows under the Accelo cap at limits 100 and 37', async (t) => {
  for (const name of ['list_activities', 'get_activity_thread']) {
    for (const limit of [100, 37]) {
      for (const rejectOrder of [false, true]) {
        await t.test(`${name}, limit=${limit}, rejectOrder=${rejectOrder}`, async (t) => {
          const rows = activities(250);
          mockAccelo(t, rows, { rejectOrder });
          const received = [];
          for (let page = 0; page <= Math.ceil(rows.length / limit); page++) {
            const args = name === 'list_activities'
              ? { against_type: 'job', against_id: '123' }
              : { id: '1' };
            const result = await call(name, { ...args, limit, page });
            assert.deepEqual(result.activities.map((row) => row.id),
              rows.slice(page * limit, (page + 1) * limit).map((row) => row.id));
            assert.equal(result.has_more, (page + 1) * limit < rows.length);
            received.push(...result.activities.map((row) => row.id));
          }
          assert.deepEqual(received, rows.map((row) => row.id));
        });
      }
    }
  }
});

test('activity read schemas reject invalid pages and explain how to follow has_more', () => {
  for (const name of [
    'list_activities', 'get_activity_thread', 'list_activity_attachments', 'list_matter_attachments',
    'list_matter_collections',
  ]) {
    const tool = tools.get(name);
    for (const page of [-1, 0.5, '1', 10001]) {
      assert.equal(tool.schema.page.safeParse(page).success, false);
    }
    assert.equal(tool.schema.page.safeParse(undefined).success, true);
    assert.equal(tool.schema.page.safeParse(0).success, true);
    assert.match(tool.description, /has_more/);
    assert.match(tool.description, /page \+ 1/);
  }
});

test('list_activity_attachments uses the production activity filter and maps metadata', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    assert.equal(url.pathname, '/api/v0/resources');
    assert.equal(url.searchParams.get('_filters'), 'activity_id(77)');
    assert.equal(url.searchParams.get('_fields'), '_ALL');
    const limit = Math.min(100, Number(url.searchParams.get('_limit')));
    assert.equal(limit, 100);
    return Response.json({
      response: [{
        id: 'resource-1', title: 'Engagement', filename: 'engagement.pdf',
        mime_type: 'application/pdf', filesize: '1200', date_created: '1700000000', activity_id: '77',
      }],
    });
  });
  const result = await call('list_activity_attachments', { activity_id: '77' });
  assert.equal(result.attachments[0].title, 'Engagement');
  assert.equal(result.attachments[0].filename, 'engagement.pdf');
  assert.equal(result.attachments[0].mimetype, 'application/pdf');
  assert.equal(result.attachments[0].activity_id, '77');
  assert.equal(result.has_more, false);
  assert.equal(requests.length, 1);
});

test('activity attachment tools verify supported references and fail closed', async (t) => {
  const cases = [
    ['activity_id', [{ activity_id: 77 }], null],
    ['owner', [{ owner_type: 'AcTiViTy', owner_id: 77 }], null],
    ['against', [{ against_type: 'ACTIVITY', against_id: '77' }], null],
    ['nested activity', [{ activity: { id: 77 } }], null],
    ['activity string', [{ activity: 'activities/77' }], null],
    ['activity string numeric', [{ activity: '77' }], null],
    ['activity string case insensitive', [{ activity: 'ACTIVITIES/77' }], null],
    ['nested owner', [{ owner: { type: 'Activity', id: '77' } }], null],
    ['owner string', [{ owner: 'activities/77' }], null],
    ['unrelated owner with matching activity', [{ activity_id: '77', owner_type: 'staff', owner_id: '2', owner: 'staff/2' }], null],
    ['unrelated against with matching activity', [{ activity_id: '77', against_type: 'job', against_id: '20' }], null],
    ['mismatched activity', [{ activity_id: '78' }], { status: 'filter_not_applied', mismatch_count: 1 }],
    ['mismatched owner', [{ owner_type: 'activity', owner_id: '78' }], { status: 'filter_not_applied', mismatch_count: 1 }],
    ['wrong type', [{ against_type: 'job', against_id: '77' }], { status: 'scope_unverifiable', reference_keys_seen: ['against_id', 'against_type', 'filename', 'id'] }],
    ['partial reference', [{ owner_id: '77' }], { status: 'scope_unverifiable', reference_keys_seen: ['filename', 'id', 'owner_id'] }],
    ['staff owner', [{ owner_type: 'staff', owner_id: '2' }], { status: 'scope_unverifiable', reference_keys_seen: ['filename', 'id', 'owner_id', 'owner_type'] }],
    ['staff owner string', [{ owner: 'staff/2' }], { status: 'scope_unverifiable', reference_keys_seen: ['filename', 'id', 'owner'] }],
    ['staff owner object', [{ owner: { type: 'staff', id: '2' } }], { status: 'scope_unverifiable', reference_keys_seen: ['filename', 'id', 'owner'] }],
    ['untyped nested owner', [{ owner: { id: '77' } }], { status: 'scope_unverifiable', reference_keys_seen: ['filename', 'id', 'owner'] }],
    ['activity object without id', [{ activity: {} }], { status: 'scope_unverifiable', reference_keys_seen: ['activity', 'filename', 'id'] }],
    ['activity type without id', [{ owner_type: 'activity' }], { status: 'filter_not_applied', mismatch_count: 1 }],
    ['nested mismatch', [{ activity: { id: '78' } }], { status: 'filter_not_applied', mismatch_count: 1 }],
    ['activity string mismatch', [{ activity: 'activities/78' }], { status: 'filter_not_applied', mismatch_count: 1 }],
    ['activity string wrong prefix', [{ activity: 'jobs/77' }], { status: 'filter_not_applied', mismatch_count: 1 }],
    ['owner string mismatch', [{ owner: 'activities/78' }], { status: 'filter_not_applied', mismatch_count: 1 }],
    ['owner string malformed', [{ owner: 'activities/not-a-number' }], { status: 'filter_not_applied', mismatch_count: 1 }],
    ['against mismatch', [{ against_type: 'activity', against_id: '78' }], { status: 'filter_not_applied', mismatch_count: 1 }],
    ['multiple mismatches', [{ activity_id: '78' }, { owner: { type: 'activity', id: '79' } }], { status: 'filter_not_applied', mismatch_count: 2 }],
    ['conflicting references', [{ activity_id: '77', owner_type: 'activity', owner_id: '78' }], { status: 'filter_not_applied', mismatch_count: 1 }],
    ['missing references', [{ extra: 'sensitive' }, { another: 'sensitive' }], {
      status: 'scope_unverifiable', reference_keys_seen: ['another', 'extra', 'filename', 'id'],
    }],
    ['mismatch takes precedence', [{ activity_id: '78' }, {}], { status: 'filter_not_applied', mismatch_count: 1 }],
  ];
  for (const tool of ['list_activity_attachments', 'list_matter_attachments']) {
    for (const [label, references, expected] of cases) {
      await t.test(`${tool}: ${label}`, async (t) => {
        t.mock.method(globalThis, 'fetch', async (input) => {
          const url = new URL(input);
          const limit = Math.min(100, Number(url.searchParams.get('_limit')));
          const page = Number(url.searchParams.get('_page'));
          if (url.pathname === '/api/v0/activities') {
            return Response.json({ response: [{ id: '77' }].slice(page * limit, (page + 1) * limit) });
          }
          assert.equal(url.searchParams.get('_filters'), 'activity_id(77)');
          assert.equal(url.searchParams.get('_fields'), '_ALL');
          const rows = references.map((reference, index) => ({
            id: `resource-${index}`, filename: 'private.pdf', ...reference,
          }));
          return Response.json({ response: rows.slice(page * limit, (page + 1) * limit) });
        });
        const args = tool === 'list_activity_attachments'
          ? { activity_id: '77' }
          : { against_type: 'job', against_id: '20' };
        const result = await call(tool, args);
        if (expected) {
          assert.deepEqual(result, expected);
          assert.equal(JSON.stringify(result).includes('private.pdf'), false);
          assert.equal(JSON.stringify(result).includes('sensitive'), false);
        } else {
          assert.equal(result.attachments.length, references.length);
          assert.ok(result.attachments.every((row) => String(row.activity_id) === '77'));
        }
      });
    }
  }
});

test('activity attachment tools discard previously gathered rows on later scope failures', async (t) => {
  for (const tool of ['list_activity_attachments', 'list_matter_attachments']) {
    await t.test(tool, async (t) => {
      t.mock.method(globalThis, 'fetch', async (input) => {
        const url = new URL(input);
        const limit = Math.min(100, Number(url.searchParams.get('_limit')));
        const page = Number(url.searchParams.get('_page'));
        if (url.pathname === '/api/v0/activities') {
          return Response.json({ response: [{ id: '77' }, { id: '78' }].slice(page * limit, (page + 1) * limit) });
        }
        const activityId = url.searchParams.get('_filters') === 'activity_id(77)' ? '77' : '78';
        const rows = tool === 'list_activity_attachments'
          ? [...Array.from({ length: 100 }, () => ({ activity_id: '77', filename: 'private.pdf' })),
            { id: 'unverified', filename: 'private.pdf' }]
          : activityId === '77'
            ? [{ activity_id: '77', filename: 'private.pdf' }]
            : [{ id: 'unverified', filename: 'private.pdf' }];
        return Response.json({ response: rows.slice(page * limit, (page + 1) * limit) });
      });
      const args = tool === 'list_activity_attachments'
        ? { activity_id: '77', limit: 100 }
        : { against_type: 'job', against_id: '20' };
      assert.deepEqual(await call(tool, args), {
        status: 'scope_unverifiable', reference_keys_seen: ['filename', 'id'],
      });
    });
  }
});

test('list_matter_attachments tags files and reports the activity fan-out cap', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    const limit = Math.min(100, Number(url.searchParams.get('_limit')));
    if (url.pathname === '/api/v0/activities') {
      return Response.json({
        response: [{
          id: '77', subject: 'Client call', date_logged: '1700000000',
          date_created: '1700000000', against_type: 'job', against_id: '20',
        }].slice(0, limit),
      });
    }
    assert.equal(url.pathname, '/api/v0/resources');
    assert.equal(url.searchParams.get('_filters'), 'activity_id(77)');
    assert.equal(url.searchParams.get('_fields'), '_ALL');
    return Response.json({ response: [{
      id: 'resource-1', title: 'Engagement', filename: 'engagement.pdf', mimetype: 'application/pdf',
      activity_id: '77',
    }] });
  });
  const result = await call('list_matter_attachments', {
    against_type: 'job', against_id: '20', limit: 10,
  });
  assert.equal(result.attachments[0].activity_id, '77');
  assert.equal(result.attachments[0].activity_subject, 'Client call');
  assert.ok(result.attachments[0].date_logged);
  assert.equal(result.capped, false);
  assert.ok(requests.every((url) => url.searchParams.get('_limit') === '100'));

  const manyActivities = Array.from({ length: 101 }, (_, index) => ({
    id: String(index + 1), subject: 'Synthetic activity', date_logged: '1700000000',
  }));
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    const limit = Math.min(100, Number(url.searchParams.get('_limit')));
    if (url.pathname === '/api/v0/activities') {
      const page = Number(url.searchParams.get('_page'));
      return Response.json({ response: manyActivities.slice(page * limit, (page + 1) * limit) });
    }
    return Response.json({ response: [] });
  });
  const capped = await call('list_matter_attachments', {
    against_type: 'job', against_id: '20', limit: 10,
  });
  assert.equal(capped.capped, true);
  assert.equal(capped.activities_gathered, 100);
  assert.equal(capped.has_more, true);
});

test('list_matter_attachments fails closed when a resource does not match its activity', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname === '/api/v0/activities') {
      return Response.json({ response: [{ id: '77', subject: 'Client call' }] });
    }
    return Response.json({ response: [{ id: 'resource-1', activity_id: '78', filename: 'private.pdf' }] });
  });
  const result = await call('list_matter_attachments', { against_type: 'job', against_id: '20' });
  assert.deepEqual(result, { status: 'filter_not_applied', mismatch_count: 1 });
  assert.equal(JSON.stringify(result).includes('private.pdf'), false);
});

test('list_matter_collections pages collections and tags resource metadata', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    const limit = Math.min(100, Number(url.searchParams.get('_limit')));
    assert.equal(limit, 100);
    if (url.pathname === '/api/v0/jobs/20/collections') {
      return Response.json({ response: [{ id: '7', title: 'Matter Files' }].slice(0, limit) });
    }
    assert.equal(url.pathname, '/api/v0/resources');
    assert.equal(url.searchParams.get('_filters'), 'collection_id(7)');
    assert.ok(url.searchParams.get('_fields').split(',').includes('collection_id'));
    return Response.json({ response: [{
      id: 'resource-9', title: 'Pleading', filename: 'pleading.pdf',
      mime_type: 'application/pdf', filesize: '1200', date_created: '1700000000',
      collection_id: '7',
    }].slice(0, limit) });
  });
  const result = await call('list_matter_collections', {
    against_type: 'job', against_id: '20', limit: 10,
  });
  assert.deepEqual(result.attachments[0], {
    id: 'resource-9',
    title: 'Pleading',
    filename: 'pleading.pdf',
    mimetype: 'application/pdf',
    filesize: '1200',
    date_created: '1700000000',
    collection_id: '7',
    collection_title: 'Matter Files',
  });
  assert.equal(result.capped, false);
  assert.equal(result.has_more, false);
  assert.equal(result.collections_gathered, 1);
  assert.equal(requests.length, 2);
});

test('list_matter_collections discards mismatched collection rows and tries owner fallback', async (t) => {
  for (const [label, resource] of [
    ['mismatched', { id: 'foreign-resource', collection_id: '8', filename: 'private.pdf' }],
    ['missing', { id: 'foreign-resource', filename: 'private.pdf' }],
  ]) {
    await t.test(label, async (t) => {
      let ownerFallbackRequested = false;
      t.mock.method(globalThis, 'fetch', async (input) => {
        const url = new URL(input);
        if (url.pathname === '/api/v0/jobs/20/collections') {
          return Response.json({ response: [{ id: '7', title: 'Matter Files' }] });
        }
        if (url.searchParams.get('_filters') === 'collection_id(7)') {
          return Response.json({ response: [resource] });
        }
        ownerFallbackRequested = true;
        assert.equal(url.searchParams.get('_filters'), 'owner_type(job),owner_id(20)');
        assert.ok(url.searchParams.get('_fields').split(',').includes('owner_type'));
        assert.ok(url.searchParams.get('_fields').split(',').includes('owner_id'));
        return Response.json({ response: [{
          id: 'owned-resource', owner_type: 'job', owner_id: '20', filename: 'owned.pdf',
        }] });
      });
      const result = await call('list_matter_collections', { against_type: 'job', against_id: '20' });
      assert.equal(result.source, 'owner');
      assert.equal(ownerFallbackRequested, true);
      assert.deepEqual(result.attachments.map(({ id }) => id), ['owned-resource']);
      assert.equal(JSON.stringify(result).includes('private.pdf'), false);
    });
  }
});

test('list_matter_collections fails closed when owner references are missing', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/collections')) {
      return Response.json({ meta: { message: 'unsupported' } }, { status: 404 });
    }
    return Response.json({ response: [{ id: 'foreign-resource', filename: 'private.pdf' }] });
  });
  const result = await call('list_matter_collections', { against_type: 'job', against_id: '20' });
  assert.equal(result.status, 'error');
  assert.deepEqual(result.attempts, [
    { path: '/jobs/20/collections', status: 404 },
    { path: '/resources?_filters=owner_type(job),owner_id(20)', status: 200, mismatch_count: 1 },
  ]);
  assert.equal(result.attachments, undefined);
  assert.equal(JSON.stringify(result).includes('private.pdf'), false);
});

test('list_matter_collections fails closed when owner references mismatch', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/collections')) {
      return Response.json({ meta: { message: 'unsupported' } }, { status: 404 });
    }
    return Response.json({ response: [{
      id: 'foreign-resource', owner_type: 'issue', owner_id: '20', filename: 'private.pdf',
    }] });
  });
  const result = await call('list_matter_collections', { against_type: 'job', against_id: '20' });
  assert.deepEqual(result.attempts, [
    { path: '/jobs/20/collections', status: 404 },
    { path: '/resources?_filters=owner_type(job),owner_id(20)', status: 200, mismatch_count: 1 },
  ]);
  assert.equal(result.attachments, undefined);
  assert.equal(JSON.stringify(result).includes('private.pdf'), false);
});

test('list_matter_collections records scope mismatches without resource values', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/collections')) {
      return Response.json({ response: [{ id: '7' }] });
    }
    if (url.searchParams.get('_filters') === 'collection_id(7)') {
      return Response.json({ response: [{
        id: 'foreign-resource', collection_id: '8', filename: 'private.pdf',
      }] });
    }
    return Response.json({ meta: { message: 'unsupported' } }, { status: 400 });
  });
  const result = await call('list_matter_collections', { against_type: 'job', against_id: '20' });
  assert.deepEqual(result.attempts, [
    { path: '/jobs/20/collections', status: 200 },
    { path: '/resources?_filters=collection_id(7)', status: 200, mismatch_count: 1 },
    { path: '/resources?_filters=owner_type(job),owner_id(20)', status: 400 },
  ]);
  assert.equal(result.attachments, undefined);
  assert.equal(JSON.stringify(result).includes('private.pdf'), false);
});

for (const status of [400, 404]) {
  test(`list_matter_collections uses owner resources after nested endpoint returns ${status}`, async (t) => {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (input) => {
      const url = new URL(input);
      requests.push(url);
      if (url.pathname === '/api/v0/issues/20/collections') {
        return Response.json({ meta: { message: 'unsupported' } }, { status });
      }
      assert.equal(url.pathname, '/api/v0/resources');
      assert.equal(url.searchParams.get('_filters'), 'owner_type(issue),owner_id(20)');
      const limit = Math.min(100, Number(url.searchParams.get('_limit')));
      const page = Number(url.searchParams.get('_page'));
      const rows = Array.from({ length: 150 }, (_, index) => ({
        id: String(index + 1), filename: 'file.pdf', mime_type: 'application/pdf', body: 'must not be returned',
        owner_type: 'issue', owner_id: '20',
      }));
      return Response.json({ response: rows.slice(page * limit, (page + 1) * limit) });
    });
    const result = await call('list_matter_collections', {
      against_type: 'issue', against_id: '20', limit: 37, page: 2,
    });
    assert.equal(result.source, 'owner');
    assert.equal(result.attachments.length, 37);
    assert.equal(result.attachments[0].id, '75');
    assert.equal(result.attachments[0].source, 'owner');
    assert.equal(result.attachments[0].mimetype, 'application/pdf');
    assert.equal(result.attachments[0].body, undefined);
    assert.equal(result.capped, false);
    assert.equal(result.has_more, true);
    assert.equal(result.collections_gathered, 0);
    assert.equal(result.attachments_gathered, 150);
    assert.equal(requests.length, 3);
  });
}

test('list_matter_collections returns a typed error naming both failed paths and statuses', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    const status = url.pathname.endsWith('/collections') ? 404 : 400;
    return Response.json({ meta: { message: 'resource endpoint was not recognized' } }, { status });
  });
  const result = await call('list_matter_collections', { against_type: 'issue', against_id: '20' });
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'collections_unavailable');
  assert.deepEqual(result.attempts, [
    { path: '/issues/20/collections', status: 404 },
    { path: '/resources?_filters=owner_type(issue),owner_id(20)', status: 400 },
  ]);
  for (const { path, status } of result.attempts) {
    assert.ok(result.message.includes(`${path}: ${status}`));
  }
  assert.equal(result.attachments, undefined);
});

test('list_matter_collections names failed collection resource paths and discards partial rows', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/collections')) {
      return Response.json({ response: [{ id: '1' }, { id: '2' }] });
    }
    if (url.searchParams.get('_filters') === 'collection_id(1)') {
      return Response.json({ response: [{ id: 'partial', collection_id: '1' }] });
    }
    return Response.json({ meta: { message: 'unsupported' } }, { status: 400 });
  });
  const result = await call('list_matter_collections', { against_type: 'job', against_id: '20' });
  assert.equal(result.status, 'error');
  assert.deepEqual(result.attempts, [
    { path: '/jobs/20/collections', status: 200 },
    { path: '/resources?_filters=collection_id(1)', status: 200 },
    { path: '/resources?_filters=collection_id(2)', status: 400 },
    { path: '/resources?_filters=owner_type(job),owner_id(20)', status: 400 },
  ]);
  assert.equal(JSON.stringify(result).includes('partial'), false);
});

test('list_matter_collections does not fall back on denied access', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return Response.json({ meta: { message: 'denied private-client confidential.pdf' } }, { status: 403 });
  });
  await assert.rejects(call('list_matter_collections', { against_type: 'job', against_id: '20' }), {
    status: 403, message: 'Accelo metadata request failed.',
  });
  assert.equal(calls, 1);
});

test('list_matter_collections discloses the collection fan-out cap', async (t) => {
  const collections = Array.from({ length: 101 }, (_, index) => ({
    id: String(index + 1), title: `Collection ${index + 1}`,
  }));
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    const limit = Math.min(100, Number(url.searchParams.get('_limit')));
    assert.equal(limit, 100);
    if (url.pathname === '/api/v0/jobs/20/collections') {
      const page = Number(url.searchParams.get('_page'));
      return Response.json({ response: collections.slice(page * limit, (page + 1) * limit) });
    }
    return Response.json({ response: [] });
  });
  const result = await call('list_matter_collections', {
    against_type: 'job', against_id: '20', limit: 10,
  });
  assert.equal(result.capped, true);
  assert.equal(result.collections_gathered, 100);
  assert.equal(result.attachments_gathered, 0);
  assert.equal(result.has_more, true);
  assert.equal(requests.filter((url) => url.pathname === '/api/v0/jobs/20/collections').length, 2);
});

test('list_matter_collections discloses the owner resource cap', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/collections')) {
      return Response.json({ meta: { message: 'unsupported' } }, { status: 400 });
    }
    const limit = Math.min(100, Number(url.searchParams.get('_limit')));
    const page = Number(url.searchParams.get('_page'));
    const rows = Array.from({ length: 1001 }, (_, index) => ({
      id: String(index + 1), owner_type: 'job', owner_id: '20',
    }));
    return Response.json({ response: rows.slice(page * limit, (page + 1) * limit) });
  });
  const result = await call('list_matter_collections', { against_type: 'job', against_id: '20' });
  assert.equal(result.source, 'owner');
  assert.equal(result.capped, true);
  assert.equal(result.has_more, true);
  assert.equal(result.attachments_gathered, 1000);
  assert.equal(result.attachment_cap, 1000);
});

for (const shape of ['array', 'nested', 'single']) {
  for (const owner of [false, true]) {
    test(`list_matter_collections accepts ${shape} responses via ${owner ? 'owner' : 'collections'}`, async (t) => {
      const wrap = (row, key) => shape === 'array' ? [row] : shape === 'nested' ? { [key]: [row] } : row;
      const requests = [];
      t.mock.method(globalThis, 'fetch', async (input) => {
        const url = new URL(input);
        requests.push(url);
        const limit = Math.min(100, Number(url.searchParams.get('_limit')));
        assert.equal(limit, 100);
        if (url.pathname.endsWith('/collections')) {
          assert.equal(url.searchParams.get('_fields'), '_ALL');
          return Response.json({ response: owner ? { unknown: 'private client data' } : wrap({ id: '7', title: 'Files' }, 'collections') });
        }
        assert.equal(url.searchParams.get('_filters'), owner ? 'owner_type(job),owner_id(20)' : 'collection_id(7)');
        const resource = owner
          ? { id: '9', filename: 'file.pdf', owner_type: 'job', owner_id: '20' }
          : { id: '9', filename: 'file.pdf', collection_id: '7' };
        return Response.json({ response: wrap(resource, 'resources') });
      });
      const result = await call('list_matter_collections', { against_type: 'job', against_id: '20' });
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0].id, '9');
      assert.equal(result.attachments[0].filename, 'file.pdf');
      assert.equal(result.attachments[0].collection_id, owner ? undefined : '7');
      assert.equal(result.attachments[0].collection_title, owner ? undefined : 'Files');
      assert.equal(result.source, owner ? 'owner' : undefined);
      assert.equal(result.collections_gathered, owner ? 0 : 1);
      assert.equal(requests.length, 2);
      assert.equal(JSON.stringify(result).includes('private client data'), false);
    });
  }
}

test('list_matter_collections prioritizes the nested collections list for issues', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    const limit = Math.min(100, Number(url.searchParams.get('_limit')));
    if (url.pathname === '/api/v0/issues/20/collections') {
      assert.equal(url.searchParams.get('_fields'), '_ALL');
      return Response.json({ response: {
        id: '20',
        collections: [{ id: '7', title: 'Files' }].slice(0, limit),
      } });
    }
    assert.equal(url.pathname, '/api/v0/resources');
    assert.equal(url.searchParams.get('_filters'), 'collection_id(7)');
    return Response.json({ response: [{
      id: '9', filename: 'file.pdf', collection_id: '7',
    }].slice(0, limit) });
  });
  const result = await call('list_matter_collections', { against_type: 'issue', against_id: '20' });
  assert.equal(result.collections_gathered, 1);
  assert.equal(result.attachments[0].collection_id, '7');
  assert.equal(result.attachments[0].collection_title, 'Files');
  assert.equal(result.attachments[0].id, '9');
});

for (const response of [
  { unknown: 'private-client', filename: 'confidential.pdf' },
  null, 'confidential.pdf', 42, true,
  { collections: { filename: 'confidential.pdf' } },
  { id: 'confidential.pdf', title: 'private-client' },
  [{ title: 'private-client' }],
]) {
  test(`list_matter_collections records invalid shape ${JSON.stringify(response)} and owner failure`, async (t) => {
    const shape = response == null ? [] : Object.keys(response);
    t.mock.method(globalThis, 'fetch', async (input) => {
      const url = new URL(input);
      assert.equal(Math.min(100, Number(url.searchParams.get('_limit'))), 100);
      return Response.json({
        response: url.pathname.endsWith('/collections') ? response : { filename: 'confidential.pdf', unknown: 'private-client' },
      });
    });
    const result = await call('list_matter_collections', { against_type: 'issue', against_id: '20' });
    assert.equal(result.error, 'collections_unavailable');
    assert.deepEqual(result.attempts, [
      { path: '/issues/20/collections', status: 200, shape },
      { path: '/resources?_filters=owner_type(issue),owner_id(20)', status: 200, shape: ['filename', 'unknown'] },
    ]);
    assert.equal(result.attachments, undefined);
    assert.equal(JSON.stringify(result).includes('private-client'), false);
    assert.equal(JSON.stringify(result).includes('confidential.pdf'), false);
  });
}

for (const ownerFails of [false, true]) {
  test(`list_matter_collections retries invalid collection resources with owner failure=${ownerFails}`, async (t) => {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (input) => {
      const url = new URL(input);
      requests.push(url);
      const limit = Math.min(100, Number(url.searchParams.get('_limit')));
      if (url.pathname.endsWith('/collections')) {
        return Response.json({ response: [{ id: '1' }, { id: '2' }].slice(0, limit) });
      }
      if (url.searchParams.get('_filters') === 'collection_id(1)') {
        return Response.json({ response: [{
          id: '99', filename: 'partial.pdf', collection_id: '1',
        }].slice(0, limit) });
      }
      if (url.searchParams.get('_filters') === 'collection_id(2)') {
        return Response.json({ response: { unknown: 'private-client', filename: 'confidential.pdf' } });
      }
      if (ownerFails) {
        return Response.json({ meta: { message: 'confidential.pdf private-client' } }, { status: 400 });
      }
      return Response.json({ response: { resources: [{
        id: '3', filename: 'owner.pdf', owner_type: 'job', owner_id: '20',
      }].slice(0, limit) } });
    });
    const result = await call('list_matter_collections', { against_type: 'job', against_id: '20' });
    assert.equal(requests.length, 4);
    if (ownerFails) {
      assert.equal(result.error, 'collections_unavailable');
      assert.deepEqual(result.attempts, [
        { path: '/jobs/20/collections', status: 200 },
        { path: '/resources?_filters=collection_id(1)', status: 200 },
        { path: '/resources?_filters=collection_id(2)', status: 200, shape: ['unknown', 'filename'] },
        { path: '/resources?_filters=owner_type(job),owner_id(20)', status: 400 },
      ]);
    } else {
      assert.deepEqual(result.attachments.map((row) => row.id), ['3']);
      assert.equal(result.source, 'owner');
      assert.equal(result.collections_gathered, 0);
    }
    for (const value of ['partial.pdf', 'confidential.pdf', 'private-client']) {
      assert.equal(JSON.stringify(result).includes(value), false);
    }
  });
}

test('create_activity inherits the parent object for previews and confirmed writes', async (t) => {
  const requests = mockActivityWrite(t);
  const args = { parent_id: 'parent-id', subject: 'Reply', body: 'Reply body' };
  const preview = await call('create_activity', args);
  assert.equal(preview.status, 'confirmation_required');
  assert.equal(preview.pending.against, 'job(123)');
  assert.equal(requests.filter(({ options }) => options.method === 'POST').length, 0);

  const result = await call('create_activity', { ...args, confirm: true });
  assert.equal(result.status, 'created');
  const post = requests.find(({ options }) => options.method === 'POST');
  assert.ok(post);
  const fields = Object.fromEntries(new URLSearchParams(post.options.body));
  assert.equal(fields.against_type, 'job');
  assert.equal(fields.against_id, '123');
  assert.equal(fields.parent_id, 'parent-id');
  assert.equal(fields.medium, 'note');
});

test('create_activity rejects an explicit against object that differs from its parent', async (t) => {
  const requests = mockActivityWrite(t);
  const result = await call('create_activity', {
    parent_id: 'parent-id',
    against_type: 'issue',
    against_id: '123',
    subject: 'Reply',
    body: 'Reply body',
    confirm: true,
  });
  assert.equal(result.status, 'error');
  assert.match(result.message, /against_type does not match/i);
  assert.equal(requests.filter(({ options }) => options.method === 'POST').length, 0);
});

test('create_activity requires an against pair when no parent activity is supplied', async (t) => {
  const requests = mockActivityWrite(t);
  const result = await call('create_activity', {
    subject: 'Standalone note',
    body: 'Note body',
    confirm: true,
  });
  assert.equal(result.status, 'error');
  assert.match(result.message, /against_type and against_id are required/i);
  assert.equal(requests.length, 0);
});

test('create_activity uses the subject as body for time entries', async (t) => {
  const requests = mockActivityWrite(t);
  const args = {
    against_type: 'issue',
    against_id: '456',
    subject: 'Review filing',
    time_minutes: 15,
  };
  const preview = await call('create_activity', args);
  assert.equal(preview.pending.body, args.subject);
  const result = await call('create_activity', { ...args, confirm: true });
  assert.equal(result.status, 'created');
  const fields = Object.fromEntries(new URLSearchParams(
    requests.find(({ options }) => options.method === 'POST').options.body,
  ));
  assert.equal(fields.body, args.subject);
  assert.equal(fields.billable, '900');
});

test('log_note inherits parent, logs time, and cannot produce an email medium', async (t) => {
  const requests = mockActivityWrite(t);
  assert.equal(tools.get('log_note').schema.medium, undefined);
  const result = await call('log_note', {
    parent_id: 'parent-id',
    subject: 'Review filing',
    time_minutes: 20,
    billable: false,
    medium: 'email',
    confirm: true,
  });
  assert.equal(result.status, 'created');
  const fields = Object.fromEntries(new URLSearchParams(
    requests.find(({ options }) => options.method === 'POST').options.body,
  ));
  assert.equal(fields.against_type, 'job');
  assert.equal(fields.against_id, '123');
  assert.equal(fields.parent_id, 'parent-id');
  assert.equal(fields.medium, 'note');
  assert.equal(fields.body, 'Review filing');
  assert.equal(fields.nonbillable, '1200');
});

test('only create_activity and log_note are registered for writes', () => {
  for (const name of ['create_activity', 'log_note']) assert.ok(tools.has(name));
  for (const name of ['log_email', 'reply_to_activity', 'log_time']) assert.ok(!tools.has(name));
});
