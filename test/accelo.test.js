import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.PUBLIC_BASE_URL = 'http://127.0.0.1';
process.env.ACCELO_CLIENT_ID = 'test-client';
process.env.ACCELO_CLIENT_SECRET = 'test-secret';
process.env.TOKEN_DB_PATH = ':memory:';

const { acceloGet, acceloPost, acceloPut, acceloTryPost, withAcceloRetryBudget } = await import('../src/accelo.js');

function installTimers(t, delays) {
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    delays.push(delay);
    queueMicrotask(callback);
    return 0;
  });
}

function response(status, headers = {}) {
  return Response.json({ meta: { message: 'temporary failure' } }, { status, headers });
}

test('GET retries 429, 502, 503, and 504 with exponential fallback', async (t) => {
  for (const status of [429, 502, 503, 504]) {
    const delays = [];
    installTimers(t, delays);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? response(status) : Response.json({ response: [] }));
    await withAcceloRetryBudget(() => acceloGet('token', '/test'));
    assert.equal(calls, 2);
    assert.deepEqual(delays, [1000]);
    t.mock.restoreAll();
  }
});

test('GET honors Retry-After and X-RateLimit-Reset', async (t) => {
  const delays = [];
  installTimers(t, delays);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return response(429, { 'Retry-After': '0.25' });
    if (calls === 2) return response(429, { 'X-RateLimit-Reset': String(Math.ceil(Date.now() / 1000) + 10) });
    return Response.json({ response: [] });
  });
  await withAcceloRetryBudget(() => acceloGet('token', '/test'));
  assert.equal(calls, 3);
  assert.equal(delays[0], 250);
  assert.ok(delays[1] >= 8000 && delays[1] < 20000);
});

test('POST and PUT retry 429 only and never retry 502', async (t) => {
  const delays = [];
  installTimers(t, delays);
  for (const [method, request] of [['POST', acceloPost], ['PUT', acceloPut]]) {
    let calls = 0;
    installTimers(t, delays);
    t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? response(429) : Response.json({ response: {} }));
    await withAcceloRetryBudget(() => request('token', '/test', { title: 'test' }));
    assert.equal(calls, 2);
    t.mock.restoreAll();

    calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls += 1; return response(502); });
    await assert.rejects(withAcceloRetryBudget(() => request('token', '/test', {})), { status: 502 });
    assert.equal(calls, 1);
    t.mock.restoreAll();
  }
});

test('GET never retries 400, 401, 403, or 404 and stops after three retries', async (t) => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls += 1; return response(status); });
    await assert.rejects(withAcceloRetryBudget(() => acceloGet('token', '/test')), { status });
    assert.equal(calls, 1);
    t.mock.restoreAll();
  }
  installTimers(t, []);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return response(429); });
  await assert.rejects(withAcceloRetryBudget(() => acceloGet('token', '/test')), { status: 429 });
  assert.equal(calls, 4);
});

test('retry wait is capped at 20 seconds for the whole tool call', async (t) => {
  const delays = [];
  installTimers(t, delays);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls === 1) return response(429, { 'Retry-After': '10' });
    if (calls === 2) return Response.json({ response: [] });
    return response(429, { 'Retry-After': '15' });
  });
  await assert.rejects(withAcceloRetryBudget(async () => {
    await acceloGet('token', '/first');
    await acceloGet('token', '/second');
  }), { status: 429 });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10000, 10000]);
});

test('HTTP 200 meta.status=ok and responses without meta return their JSON', async (t) => {
  const expected = { meta: { status: 'ok' }, response: [] };
  t.mock.method(globalThis, 'fetch', async () => Response.json(expected));
  assert.deepEqual(await acceloGet('token', '/test'), expected);
  t.mock.restoreAll();

  const withoutMeta = { response: [] };
  t.mock.method(globalThis, 'fetch', async () => Response.json(withoutMeta));
  assert.deepEqual(await acceloGet('token', '/test'), withoutMeta);
});

test('HTTP 200 with non-ok meta.status fails without retry and supports allowError', async (t) => {
  let calls = 0;
  const rejected = () => Response.json({
    meta: { status: 'error', message: 'invalid write' },
  });
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return rejected(); });
  await assert.rejects(acceloPut('token', '/draft', { title: 'test' }), (error) => {
    assert.equal(error.message, 'Accelo API PUT /draft failed: 200 error invalid write');
    assert.equal(error.status, 200);
    assert.equal(error.acceloStatus, 'error');
    return true;
  });
  assert.equal(calls, 1);
  t.mock.restoreAll();

  calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return rejected(); });
  assert.deepEqual(await acceloTryPost('token', '/draft', {}), {
    ok: false,
    status: 200,
    json: { meta: { status: 'error', message: 'invalid write' } },
    message: 'invalid write',
  });
  assert.equal(calls, 1);
});

test('401 retries once with a fresh token for reads and writes', async (t) => {
  for (const [method, request] of [['GET', () => acceloGet('old-token', '/test')], ['PUT', () => acceloPut('old-token', '/test', {})]]) {
    let calls = 0;
    const authorizations = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      calls += 1;
      authorizations.push(options.headers.Authorization);
      return calls === 1
        ? Response.json({ meta: { message: 'unauthorized' } }, { status: 401 })
        : Response.json({ meta: { status: 'ok' }, response: [] });
    });
    let refreshes = 0;
    await withAcceloRetryBudget(request, { reauth: async () => { refreshes += 1; return 'new-token'; } });
    assert.equal(calls, 2);
    assert.equal(refreshes, 1);
    assert.ok(authorizations[0].endsWith('old-token'));
    assert.ok(authorizations[1].endsWith('new-token'));
    t.mock.restoreAll();
  }
});

test('a second 401 fails after exactly one reauthorization', async (t) => {
  let calls = 0;
  let refreshes = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return Response.json({ meta: { message: 'unauthorized' } }, { status: 401 });
  });
  await assert.rejects(
    withAcceloRetryBudget(() => acceloGet('old-token', '/test'), {
      reauth: async () => { refreshes += 1; return 'new-token'; },
    }),
    (error) => error.message.includes('Accelo re-authorization required')
  );
  assert.equal(calls, 2);
  assert.equal(refreshes, 1);
});

test('a failed reauthorization returns the typed reauthorization error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ meta: { message: 'unauthorized' } }, { status: 401 }));
  await assert.rejects(
    withAcceloRetryBudget(() => acceloGet('old-token', '/test'), {
      reauth: async () => { throw new Error('private refresh failure'); },
    }),
    (error) => error.message.includes('Accelo re-authorization required') && error.status === 401
  );
});
