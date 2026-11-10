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
process.env.ACCELO_BASE_URL = 'https://test.api.accelo.com/api/v0';
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
      const limit = Math.min(100, Number(url.searchParams.get('_limit')));
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
    const limit = Math.min(100, Number(query.get('_limit')));
    const page = Number(query.get('_page'));
    assert.ok(query.has('_page'));
    return Response.json({ response: rows.slice(page * limit, (page + 1) * limit) });
  });
  return requests;
}

async function call(args) {
  return callTool('list_project_activities', args);
}

async function callTool(name, args) {
  const tool = tools.get(name);
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

function companyJobs(count, companyId = '321') {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    title: `Matter ${index + 1}`,
    against_type: 'company',
    against_id: companyId,
    standing: ['active', 'inactive', 'paused', 'closed', 'complete'][index % 5],
    job_status: 'status',
    date_started: '1700000000',
    date_completed: null,
  }));
}

function mockJobReads(t, handler) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    const response = await handler(url);
    return response instanceof Response ? response : Response.json(response);
  });
  return requests;
}

test('list_jobs rejects rows when Accelo ignores the company filter', async (t) => {
  mockJobReads(t, () => ({ response: companyJobs(1, '999') }));
  const result = await callTool('list_jobs', { company_id: '321' });

  assert.deepEqual(result, { status: 'filter_not_applied', mismatch_count: 1 });
  assert.equal(Object.hasOwn(result, 'jobs'), false);
});

test('list_jobs rejects company mismatches on the lookahead upstream page', async (t) => {
  const requests = mockJobReads(t, (url) => ({
    response: url.searchParams.get('_page') === '0' ? companyJobs(100) : companyJobs(1, '999'),
  }));
  const result = await callTool('list_jobs', { company_id: '321', limit: 100 });

  assert.deepEqual(result, { status: 'filter_not_applied', mismatch_count: 1 });
  assert.deepEqual(requests.map((url) => url.searchParams.get('_page')), ['0', '1']);
});

test('list_jobs preserves standing filters and total metadata across upstream pages', async (t) => {
  const rows = companyJobs(150);
  const requests = mockJobReads(t, (url) => {
    assert.equal(url.searchParams.get('_filters'),
      'against_type(company),against_id(321),standing(active|paused)');
    assert.equal(url.searchParams.get('_limit'), '100');
    const page = Number(url.searchParams.get('_page'));
    return {
      response: rows.slice(page * 100, (page + 1) * 100),
      ...(page === 1 ? { meta: { total: rows.length } } : {}),
    };
  });
  const result = await callTool('list_jobs', {
    company_id: '321', standing: ['active', 'paused'], limit: 37, page: 2,
  });

  assert.deepEqual(result.jobs.map((job) => job.id), rows.slice(74, 111).map((job) => job.id));
  assert.equal(result.has_more, true);
  assert.equal(result.total, 150);
  assert.deepEqual(requests.map((url) => url.searchParams.get('_page')), ['0', '1']);
});

test('list_jobs paginates without gaps and preserves Accelo standings', async (t) => {
  const rows = companyJobs(5);
  const requests = mockJobReads(t, (url) => {
    assert.equal(url.pathname, '/api/v0/jobs');
    assert.equal(url.searchParams.get('_filters'), 'against_type(company),against_id(321)');
    const limit = Math.min(100, Number(url.searchParams.get('_limit')));
    const page = Number(url.searchParams.get('_page'));
    return { response: rows.slice(page * limit, (page + 1) * limit), meta: { total: rows.length } };
  });

  const first = await callTool('list_jobs', { company_id: '321', limit: 2, page: 0 });
  const second = await callTool('list_jobs', { company_id: '321', limit: 2, page: 1 });
  const third = await callTool('list_jobs', { company_id: '321', limit: 2, page: 2 });

  assert.deepEqual(first.jobs.map((job) => job.id), ['1', '2']);
  assert.equal(first.has_more, true);
  assert.deepEqual(second.jobs.map((job) => job.id), ['3', '4']);
  assert.equal(second.has_more, true);
  assert.deepEqual(third.jobs.map((job) => job.id), ['5']);
  assert.equal(third.has_more, false);
  assert.deepEqual([...first.jobs, ...second.jobs, ...third.jobs].map((job) => job.standing),
    ['active', 'inactive', 'paused', 'closed', 'complete']);
  assert.notEqual(second.jobs[1].standing, 'active');
  assert.equal(first.total, 5);
  assert.ok(requests.every((url) => url.searchParams.get('_limit') === '100'));
  assert.ok(requests.every((url) => url.searchParams.has('_page')));
  assert.equal(first.jobs[0].url, 'https://test.accelo.com/?action=view_job&id=1');
});

test('get_job returns a typed not_found for an ID that is not a job', async (t) => {
  const requests = mockJobReads(t, (url) => {
    if (url.pathname === '/api/v0/jobs/321') return { response: null };
    if (url.pathname === '/api/v0/issues/321') return { response: { id: '321' } };
    throw new Error(`Unexpected request: ${url.pathname}`);
  });

  const result = await callTool('get_job', { job_id: '321' });

  assert.deepEqual(result, { status: 'not_found', object_type: 'job' });
  assert.deepEqual(requests.map((url) => url.pathname), ['/api/v0/jobs/321']);
});

test('get_job returns typed not_found only for HTTP 400 and 404', async (t) => {
  for (const status of [400, 404, 401, 403, 429, 500]) {
    await t.test(`HTTP ${status}`, async (t) => {
      const requests = mockJobReads(t, (url) => {
        assert.equal(url.pathname, '/api/v0/jobs/321');
        return Response.json({ meta: { message: 'Synthetic upstream error mentioning 400 and 404' } }, { status });
      });
      if (status === 400 || status === 404) {
        assert.deepEqual(await callTool('get_job', { job_id: '321' }),
          { status: 'not_found', object_type: 'job' });
      } else {
        if (status === 429) {
          t.mock.method(globalThis, 'setTimeout', (callback) => {
            queueMicrotask(callback);
            return 0;
          });
        }
        await assert.rejects(callTool('get_job', { job_id: '321' }), new RegExp(` ${status} `));
      }
      assert.equal(requests.length, status === 429 ? 4 : 1);
    });
  }
});

test('job and project activity reads page 250 rows under the Accelo cap at limits 100 and 37', async (t) => {
  for (const name of ['list_jobs', 'list_project_activities']) {
    for (const limit of [100, 37]) {
      await t.test(`${name}, limit=${limit}`, async (t) => {
        const rows = name === 'list_jobs'
          ? companyJobs(250)
          : activities(Array.from({ length: 250 }, (_, index) => index + 1));
        if (name === 'list_jobs') {
          mockJobReads(t, (url) => {
            const size = Math.min(100, Number(url.searchParams.get('_limit')));
            const page = Number(url.searchParams.get('_page'));
            return { response: rows.slice(page * size, (page + 1) * size) };
          });
        } else {
          mockAccelo(t, { 'job:123': rows });
        }
        const received = [];
        for (let page = 0; page <= Math.ceil(rows.length / limit); page++) {
          const args = name === 'list_jobs' ? { company_id: '321' } : { job_id: '123' };
          const result = await callTool(name, { ...args, limit, page });
          const resultRows = result.jobs || result.activities;
          assert.deepEqual(resultRows.map((row) => row.id),
            rows.slice(page * limit, (page + 1) * limit).map((row) => row.id));
          assert.equal(result.has_more, (page + 1) * limit < rows.length);
          received.push(...resultRows.map((row) => row.id));
        }
        assert.deepEqual(received, rows.map((row) => row.id));
      });
    }
  }
});

test('get_job and get_project_plan expose job company references', async (t) => {
  const job = {
    id: '321',
    title: 'Matter',
    against: { id: '456' },
    against_type: 'company',
    against_id: '456',
    company: { id: '456' },
    standing: 'inactive',
    job_status: 'job-status',
    date_started: '1700000000',
    date_completed: '1700000100',
  };
  mockJobReads(t, (url) => {
    if (url.pathname === '/api/v0/jobs/321') return { response: job };
    if (url.pathname === '/api/v0/jobs/321/milestones') return { response: [] };
    if (url.pathname === '/api/v0/tasks') return { response: [] };
    throw new Error(`Unexpected request: ${url.pathname}`);
  });

  const single = await callTool('get_job', { job_id: '321' });
  const plan = await callTool('get_project_plan', { job_id: '321' });

  assert.equal(single.against_type, 'company');
  assert.equal(single.against_id, '456');
  assert.equal(single.company_id, '456');
  assert.equal(plan.job.against_type, 'company');
  assert.equal(plan.job.against_id, '456');
  assert.equal(plan.job.job_status, 'job-status');
});

test('project profile values distinguish definition and value IDs and allow field selection', async (t) => {
  const requests = mockJobReads(t, (url) => {
    assert.equal(url.searchParams.get('_fields'), 'id,value,field_id,field_name,field_type');
    return { response: [
      { id: '9001', field_id: '62', field_name: 'Project Folder', field_type: 'hyperlink', value: 'https://drive.example/one' },
      { id: '9002', field_id: '63', field_name: 'Summary', field_type: 'text', value: 'summary' },
    ] };
  });

  const values = await callTool('get_project_profile_values', { job_id: '321', field_id: '62' });

  assert.equal(values.length, 1);
  assert.equal(values[0].field_id, '62');
  assert.equal(values[0].value_id, '9001');
  assert.equal(values[0].id, '9001');
  assert.notEqual(values[0].field_id, values[0].value_id);
  assert.equal(requests.length, 1);
});
