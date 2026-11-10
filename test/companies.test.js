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
  assert.equal(result.exact_match, false);
  assert.match(result.hint, /Tradename.*get_company_profile_values/);
});

for (const name of ['Company One', 'company one', 'COMPANY ONE']) {
  test(`search_companies identifies an exact name match for ${name}`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ response: [{ id: '1', name: 'Company One' }] }));
    const result = await call('search_companies', { name });
    assert.equal(result.exact_match, true);
    assert.equal(result.hint, undefined);
  });
}

test('search_companies suggests Tradename lookup for no candidates without fan-out', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return Response.json({ response: [] });
  });
  const result = await call('search_companies', { name: 'Short Name' });
  assert.equal(result.exact_match, false);
  assert.match(result.hint, /Tradename/);
  assert.equal(calls, 1);
});

test('get_company_profile_values normalizes field/value IDs and filters by field definition', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    assert.equal(url.pathname, '/api/v0/companies/10/profiles/values');
    assert.equal(Math.min(100, Number(url.searchParams.get('_limit'))), 100);
    return Response.json({ response: [
      { id: '900', field_id: '62', field_name: 'Tradename', field_type: 'text', value: 'Short Name' },
      { value_id: '901', field: { id: 63, name: 'Other', type: 'text' }, value: 'Other Value' },
    ] });
  });
  const values = await call('get_company_profile_values', { company_id: '10' });
  assert.equal(values.length, 2);
  assert.deepEqual(values[0], {
    id: '900', value_id: '900', field_id: '62',
    field_name: 'Tradename', field_type: 'text', value: 'Short Name',
  });
  assert.equal(values[1].field_id, 63);
  assert.equal(values[1].field_name, 'Other');
  assert.equal(values[1].field_type, 'text');
  assert.deepEqual(await call('get_company_profile_values', { company_id: '10', field_id: '62' }), [values[0]]);
  assert.deepEqual(await call('get_company_profile_values', { company_id: '10', field_id: '900' }), []);
  await assert.rejects(call('get_company_profile_values', { company_id: '../10' }));
  await assert.rejects(call('get_company_profile_values', { company_id: '10', field_id: 'bad' }));
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
    if (url.pathname === '/api/v0/affiliations/501') {
      assert.match(url.searchParams.get('_fields'), /contact\(id,firstname,surname,email\)/);
      return Response.json({ response: {
        id: '501', company: '10', position: 'Owner', standing: 'active',
        email: 'one@example.test', phone: '555-0100', mobile: '555-0101',
        contact: { id: '5', firstname: 'Contact', surname: 'One' },
      } });
    }
    if (url.pathname === '/api/v0/affiliations') {
      assert.equal(url.searchParams.get('_filters'), 'company(10)');
      const limit = Math.min(100, Number(url.searchParams.get('_limit')));
      return Response.json({
        response: [{
          id: '501', company: { id: '10' }, position: 'Owner',
          contact: { id: '5', name: 'Contact One', email: 'one@example.test', phone: '555-0100' },
        }, {
          id: '502', company: '10', contact: { id: '6', firstname: 'Contact', surname: 'Two' },
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
  assert.equal(result.contacts[0].contact_id, '5');
  assert.equal(result.contacts[0].name, 'Contact One');
  assert.equal(result.contacts[0].firstname, 'Contact');
  assert.equal(result.contacts[0].surname, 'One');
  assert.equal(result.contacts[0].phone, '555-0100');
  assert.equal(result.contacts[0].mobile, '555-0101');
  assert.equal(result.contacts[0].position, 'Owner');
  assert.equal(result.contacts[0].standing, 'active');
  assert.equal(result.contacts.length, 2);
  assert.equal(result.contacts[1].is_matter_affiliation, false);
  assert.equal(result.has_more, false);
  assert.equal(result.roster_filter, 'company');
  assert.ok(requests.some((url) => url.pathname === '/api/v0/affiliations'));
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

test('get_matter_contacts preserves the own affiliation when all roster filters fail', async (t) => {
  const filters = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname === '/api/v0/jobs/20') {
      return Response.json({ response: { company: '10', affiliation: '501' } });
    }
    if (url.pathname === '/api/v0/affiliations/501') {
      return Response.json({ response: { id: '501', contact: { id: '5', firstname: 'Contact', surname: 'One' } } });
    }
    assert.equal(url.pathname, '/api/v0/affiliations');
    filters.push(url.searchParams.get('_filters'));
    return Response.json({ meta: { message: 'resource endpoint was not recognized' } }, { status: 400 });
  });
  const result = await call('get_matter_contacts', { against_type: 'job', against_id: '20' });
  assert.deepEqual(filters, ['company(10)', 'company_id(10)', 'against_type(company),against_id(10)']);
  assert.equal(result.roster_error, 'company(10): 400; company_id(10): 400; against_type(company),against_id(10): 400');
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].name, 'Contact One');
  assert.equal(result.contacts[0].is_matter_affiliation, true);
});

for (const outcome of ['400', 'mismatch', 'invalid', '403']) {
  test(`get_matter_contacts retries company_id after company returns ${outcome}`, async (t) => {
    const filters = [];
    t.mock.method(globalThis, 'fetch', async (input) => {
      const url = new URL(input);
      if (url.pathname === '/api/v0/issues/20') {
        return Response.json({ response: { affiliation_id: '501' } });
      }
      if (url.pathname === '/api/v0/affiliations/501') {
        return Response.json({ response: { id: '501', company: { id: '10' }, contact: { id: '5' } } });
      }
      const filter = url.searchParams.get('_filters');
      filters.push(filter);
      const limit = Math.min(100, Number(url.searchParams.get('_limit')));
      if (filter === 'company(10)') {
        if (outcome === 'mismatch') {
          return Response.json({ response: Array.from({ length: 100 }, (_, index) => ({
            id: String(1000 + index), company: '99', contact: { firstname: 'Foreign' },
          })).slice(0, limit) });
        }
        if (outcome === 'invalid') return Response.json({ response: { unknown: 'private' } });
        return Response.json({ meta: { message: 'unsupported filter' } }, { status: Number(outcome) });
      }
      return Response.json({ response: [{ id: '502', company: '10', contact: { id: '6' } }].slice(0, limit) });
    });
    const result = await call('get_matter_contacts', { against_type: 'issue', against_id: '20' });
    assert.deepEqual(filters, ['company(10)', 'company_id(10)']);
    assert.equal(result.contacts.length, 2);
    assert.equal(result.roster_filter, 'company_id');
    assert.equal(result.status, undefined);
    assert.equal(JSON.stringify(result).includes('Foreign'), false);
    assert.equal(result.roster_error, undefined);
  });
}

test('get_matter_contacts tries the against filter after both company filters fail', async (t) => {
  const filters = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname === '/api/v0/jobs/20') {
      return Response.json({ response: { company: '10', affiliation: '501' } });
    }
    if (url.pathname === '/api/v0/affiliations/501') {
      return Response.json({ response: { id: '501', contact: { id: '5' } } });
    }
    const filter = url.searchParams.get('_filters');
    filters.push(filter);
    const limit = Math.min(100, Number(url.searchParams.get('_limit')));
    return Response.json({ response: [{
      id: '502', company: filter.startsWith('against_type') ? '10' : '99', contact: { id: '6' },
    }].slice(0, limit) });
  });
  const result = await call('get_matter_contacts', { against_type: 'job', against_id: '20' });
  assert.deepEqual(filters, ['company(10)', 'company_id(10)', 'against_type(company),against_id(10)']);
  assert.equal(result.roster_filter, 'against_type,against_id');
  assert.deepEqual(result.contacts.map((row) => row.id), ['5', '6']);
  assert.equal(result.roster_error, undefined);
  assert.equal(result.status, undefined);
});

for (const company of ['99', null]) {
  test(`get_matter_contacts fails closed for an unverified roster company (${company})`, async (t) => {
    t.mock.method(globalThis, 'fetch', async (input) => {
      const url = new URL(input);
      if (url.pathname === '/api/v0/jobs/20') {
        return Response.json({ response: { company: '10', affiliation: '501' } });
      }
      if (url.pathname === '/api/v0/affiliations/501') {
        return Response.json({ response: { id: '501', contact: { id: '5' } } });
      }
      const limit = Math.min(100, Number(url.searchParams.get('_limit')));
      return Response.json({ response: [
        { id: '502', company: '10', contact: { id: '6' } },
        { id: '999', company, contact: { id: '99', firstname: 'Foreign' } },
      ].slice(0, limit) });
    });
    const result = await call('get_matter_contacts', { against_type: 'job', against_id: '20' });
    assert.equal(result.status, 'filter_not_applied');
    assert.equal(result.mismatch_count, 1);
    assert.equal(result.roster_error, 'company(10): mismatch:1; company_id(10): mismatch:1; against_type(company),against_id(10): mismatch:1');
    assert.equal(result.roster_filter, undefined);
    assert.deepEqual(result.contacts.map((row) => row.affiliation_id), ['501']);
    assert.equal(JSON.stringify(result).includes('Foreign'), false);
  });
}

test('get_matter_contacts verifies subsequent capped roster pages', async (t) => {
  const pages = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.pathname === '/api/v0/jobs/20') {
      return Response.json({ response: { company: '10', affiliation: '501' } });
    }
    if (url.pathname === '/api/v0/affiliations/501') {
      return Response.json({ response: { id: '501', contact: { id: '5' } } });
    }
    const page = Number(url.searchParams.get('_page'));
    const limit = Math.min(100, Number(url.searchParams.get('_limit')));
    pages.push(page);
    const rows = Array.from({ length: 101 }, (_, index) => ({
      id: String(1000 + index), company: index === 100 ? '99' : '10',
    }));
    return Response.json({ response: rows.slice(page * limit, (page + 1) * limit) });
  });
  const result = await call('get_matter_contacts', { against_type: 'job', against_id: '20' });
  assert.deepEqual(pages, [0, 1, 0, 1, 0, 1]);
  assert.equal(result.status, 'filter_not_applied');
  assert.equal(result.contacts.length, 1);
});
