import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.PUBLIC_BASE_URL = 'http://127.0.0.1';
process.env.ACCELO_CLIENT_ID = 'test-client';
process.env.ACCELO_CLIENT_SECRET = 'test-secret';
process.env.TOKEN_DB_PATH = ':memory:';

const { acceloGet, acceloPost, acceloPut, withAcceloRetryBudget } = await import('../src/accelo.js');

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
    if (calls === 2) return response(429, { 'X-RateLimit-Reset': String(Math.ceil(Date.now() / 1000) + 2) });
    return Response.json({ response: [] });
  });
  await withAcceloRetryBudget(() => acceloGet('token', '/test'));
  assert.equal(calls, 3);
  assert.equal(delays[0], 250);
  assert.ok(delays[1] >= 1000 && delays[1] <= 2000);
});

test('POST and PUT retry 429 only and never retry 502', async (t) => {
  const delays = [];
  installTimers(t, delays);
  for (const [method, request] of [['POST', acceloPost], ['PUT', acceloPut]]) {
    let calls = 0;
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
    return response(429, { 'Retry-After': '10' });
  });
  await assert.rejects(withAcceloRetryBudget(() => acceloGet('token', '/test')), { status: 429 });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10000, 10000]);
});
