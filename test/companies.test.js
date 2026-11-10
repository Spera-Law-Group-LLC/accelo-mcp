import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const directory = await mkdtemp(path.join(tmpdir(), 'accelo-mcp-companies-'));
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1';
process.env.ACCELO_CLIENT_ID = 'test-client';
process.env.ACCELO_CLIENT_SECRET = randomBytes(24).toString('base64url');
process.env.TOKEN_DB_PATH = path.join(directory, 'tokens.db');

const [{ registerCompanyTools }, { default: db }] = await Promise.all([
  import('../src/companies.js'),
  import('../src/db.js'),
]);

db.prepare('INSERT INTO accelo_tokens (subject, access_token, expires_at, created_at) VALUES (?,?,?,?)')
  .run('test-subject', randomBytes(24).toString('base64url'), Date.now() + 3600000, Date.now());

const tools = new Map();
registerCompanyTools({
  tool(name, description, schema, handler) {
    tools.set(name, { description, schema, handler });
  },
}, 'test-subject');

after(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

async function call(name, args) {
  const tool = tools.get(name);
  for (const [key, schema] of Object.entries(tool.schema)) schema.parse(args[key]);
  return JSON.parse((await tool.handler(args)).content[0].text);
}

test('search_companies uses fetchWindow and returns stable links with has_more', async (t) => {
  assert.equal(tools.get('search_companies').schema.page.safeParse(10001).success, false);
  const rows = Array.from({ length: 101 }, (_, index) => ({
    id: String(index + 1), name: `Company ${index + 1}`, standing: 'active',
  }));
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    const limit = Math.min(100, Number(url.searchParams.get('_limit')));
    const page = Number(url.searchParams.get('_page'));
    return Response.json({ response: rows.slice(page * limit, (page + 1) * limit) });
  });
  const result = await call('search_companies', { name: 'Company', limit: 2, page: 0 });
  assert.equal(result.companies.length, 2);
  assert.equal(result.has_more, true);
  assert.equal(result.companies[0].url, 'https://spera.accelo.com/?action=view_company&id=1');
  assert.equal(requests[0].searchParams.get('_search'), 'Company');
  assert.equal(requests[0].searchParams.get('_limit'), '100');
});

for (const status of [400, 404]) {
  test(`get_company maps HTTP ${status} to typed not_found`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ meta: { message: 'not found' } }, { status }));
    assert.deepEqual(await call('get_company', { company_id: '123' }), {
      status: 'not_found', object_type: 'company',
    });
  });
}

test('get_matter_contacts returns affiliated contacts and flags the matter affiliation', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    if (url.pathname === '/api/v0/jobs/20') {
      return Response.json({ response: { id: '20', company: { id: '10' }, affiliation: { id: '501' } } });
    }
    if (url.pathname === '/api/v0/companies/10/affiliations') {
      const limit = Math.min(100, Number(url.searchParams.get('_limit')));
      return Response.json({
        response: [{
          id: '501', position: 'Owner',
          contact: { id: '5', name: 'Contact One', email: 'one@example.test', phone: '555-0100' },
        }].slice(0, limit),
      });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const result = await call('get_matter_contacts', { against_type: 'job', against_id: '20' });
  assert.equal(result.contacts[0].id, '5');
  assert.equal(result.contacts[0].email, 'one@example.test');
  assert.equal(result.contacts[0].affiliation_id, '501');
  assert.equal(result.contacts[0].is_matter_affiliation, true);
  assert.ok(requests.some((url) => url.pathname === '/api/v0/companies/10/affiliations'));
});

test('get_matter_contacts returns an explicit empty result when the matter has no affiliation', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    requests.push(url);
    return Response.json({ response: { id: '20', company: { id: '10' }, affiliation: null } });
  });
  const result = await call('get_matter_contacts', { against_type: 'issue', against_id: '20' });
  assert.deepEqual(result, {
    against_type: 'issue', against_id: '20', affiliation_id: null,
    status: 'no_affiliation', contacts: [], has_more: false,
  });
  assert.equal(requests.length, 1);
});

test('get_matter_contacts surfaces an unsupported affiliations endpoint', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return calls === 1
      ? Response.json({ response: { id: '20', company: { id: '10' }, affiliation: { id: '501' } } })
      : Response.json({ meta: { message: 'resource endpoint was not recognized' } }, { status: 400 });
  });
  await assert.rejects(call('get_matter_contacts', { against_type: 'job', against_id: '20' }), { status: 400 });
});
