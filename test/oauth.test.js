import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';

const root = fileURLToPath(new URL('../', import.meta.url));
const clientId = 'test-client';
const clientSecret = randomBytes(24).toString('base64url');
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const redirectUri = 'https://client.example/callback';
let directory, db, child, upstream, baseUrl;
let output = '';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'accelo-mcp-oauth-'));
  upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    if (req.url !== '/token' || form.get('code') !== 'mock-accelo-code' ||
        form.get('grant_type') !== 'authorization_code') {
      res.writeHead(400).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      access_token: 'mock-upstream-access',
      refresh_token: 'mock-upstream-refresh',
      expires_in: 3600,
    }));
  });
  const upstreamPort = await listen(upstream);
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(root, 'src/index.js')], {
    cwd: directory,
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: baseUrl,
      ACCELO_CLIENT_ID: 'mock-upstream-client',
      ACCELO_CLIENT_SECRET: randomBytes(24).toString('base64url'),
      ACCELO_OAUTH_URL: `http://127.0.0.1:${upstreamPort}`,
      TOKEN_DB_PATH: path.join(directory, 'tokens.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 10000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited (${code}): ${output}`));
    });
    child.stderr.on('data', (data) => { output += data; });
    child.stdout.on('data', (data) => {
      output += data;
      if (output.includes('accelo-mcp listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  db = new Database(path.join(directory, 'tokens.db'));
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  db?.close();
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

beforeEach(() => {
  for (const table of ['clients', 'auth_state', 'auth_codes', 'access_tokens', 'refresh_tokens', 'accelo_tokens']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  const insert = db.prepare('INSERT INTO clients (client_id, client_secret, redirect_uris, created_at) VALUES (?,?,?,?)');
  insert.run(clientId, clientSecret, JSON.stringify([redirectUri]), Date.now());
  insert.run('other-client', clientSecret, JSON.stringify([redirectUri]), Date.now());
  insert.run('public-client', null, JSON.stringify([redirectUri]), Date.now());
});

function authorize(overrides = {}) {
  const params = {
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', ...overrides,
  };
  for (const key of Object.keys(params)) {
    if (params[key] === undefined) delete params[key];
  }
  return fetch(`${baseUrl}/authorize?${new URLSearchParams(params)}`, { redirect: 'manual' });
}

function token(body) {
  return fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

function seedCode(id = clientId, codeChallenge = challenge) {
  const code = randomUUID();
  db.prepare(
    'INSERT INTO auth_codes (code, client_id, redirect_uri, subject, code_challenge, code_challenge_method, expires_at) VALUES (?,?,?,?,?,?,?)'
  ).run(code, id, redirectUri, 'test-subject', codeChallenge, 'S256', Date.now() + 600000);
  return code;
}

function seedRefresh(id = clientId, expiresAt = Date.now() + 600000) {
  const refresh = randomUUID();
  db.prepare('INSERT INTO refresh_tokens (token, subject, client_id, expires_at) VALUES (?,?,?,?)')
    .run(refresh, 'test-subject', id, expiresAt);
  return refresh;
}

test('unknown authorization client is rejected without changing clients or auth state', async () => {
  const clients = db.prepare('SELECT * FROM clients ORDER BY client_id').all();
  const response = await authorize({ client_id: 'unknown-client' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'unauthorized_client' });
  assert.deepEqual(db.prepare('SELECT * FROM clients ORDER BY client_id').all(), clients);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_state').get().count, 0);
});

for (const [name, params] of [
  ['missing challenge', { code_challenge: undefined }],
  ['empty challenge', { code_challenge: '' }],
  ['plain method', { code_challenge_method: 'plain' }],
  ['empty method', { code_challenge_method: '' }],
]) {
  test(`authorization rejects ${name}`, async () => {
    const response = await authorize(params);
    assert.equal(response.status, 400);
    assert.equal(await response.text(), 'invalid_request');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_state').get().count, 0);
  });
}

test('registered redirect matching is still exact', async () => {
  const response = await authorize({ redirect_uri: `${redirectUri}/other` });
  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'redirect_uri_mismatch');
});

test('omitted challenge method defaults to S256 and is stored', async () => {
  const response = await authorize({ code_challenge_method: undefined });
  assert.equal(response.status, 302);
  const state = new URL(response.headers.get('location')).searchParams.get('state');
  const row = db.prepare('SELECT * FROM auth_state WHERE state = ?').get(state);
  assert.equal(row.code_challenge, challenge);
  assert.equal(row.code_challenge_method, 'S256');
});

for (const grant of ['authorization_code', 'refresh_token']) {
  for (const [name, credentials] of [
    ['missing client id', { client_secret: clientSecret }],
    ['mismatched client id', { client_id: 'other-client', client_secret: clientSecret }],
    ['missing secret', { client_id: clientId }],
    ['wrong same-length secret', { client_id: clientId, client_secret: '!'.repeat(clientSecret.length) }],
    ['wrong shorter secret', { client_id: clientId, client_secret: 'wrong' }],
    ['empty secret', { client_id: clientId, client_secret: '' }],
  ]) {
    test(`${grant} rejects ${name} without consuming the grant`, async () => {
      const value = grant === 'authorization_code' ? seedCode() : seedRefresh();
      const body = grant === 'authorization_code' ? { code: value, code_verifier: verifier } : { refresh_token: value };
      const response = await token({ grant_type: grant, ...body, ...credentials });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'invalid_client' });
      const table = grant === 'authorization_code' ? 'auth_codes' : 'refresh_tokens';
      const column = grant === 'authorization_code' ? 'code' : 'token';
      assert.ok(db.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).get(value));
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM access_tokens').get().count, 0);
    });
  }

  test(`${grant} rejects a deleted client`, async () => {
    const value = grant === 'authorization_code' ? seedCode() : seedRefresh();
    db.prepare('DELETE FROM clients WHERE client_id = ?').run(clientId);
    const body = grant === 'authorization_code' ? { code: value, code_verifier: verifier } : { refresh_token: value };
    const response = await token({ grant_type: grant, ...body, client_id: clientId, client_secret: clientSecret });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_client' });
  });
}

for (const [name, codeVerifier] of [['missing', undefined], ['empty', ''], ['incorrect', 'incorrect-verifier']]) {
  test(`code redemption rejects ${name} verifier without consuming the code`, async () => {
    const code = seedCode();
    const body = { grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret };
    if (codeVerifier !== undefined) body.code_verifier = codeVerifier;
    const response = await token(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_grant');
    assert.ok(db.prepare('SELECT * FROM auth_codes WHERE code = ?').get(code));
  });
}

test('legacy code without a challenge cannot bypass PKCE', async () => {
  const response = await token({
    grant_type: 'authorization_code', code: seedCode(clientId, null),
    client_id: clientId, client_secret: clientSecret, code_verifier: verifier,
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_grant');
});

test('failed client authentication does not delete even an expired refresh token', async () => {
  const refresh = seedRefresh(clientId, Date.now() - 1000);
  const response = await token({
    grant_type: 'refresh_token', refresh_token: refresh, client_id: 'other-client', client_secret: clientSecret,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_client' });
  assert.ok(db.prepare('SELECT * FROM refresh_tokens WHERE token = ?').get(refresh));
});

test('NULL-secret registered clients still require their own id and PKCE', async () => {
  const response = await token({
    grant_type: 'authorization_code', code: seedCode('public-client'),
    client_id: 'public-client', code_verifier: verifier,
  });
  assert.equal(response.status, 200);
  const issued = await response.json();
  const refreshed = await token({
    grant_type: 'refresh_token', refresh_token: issued.refresh_token, client_id: 'public-client',
  });
  assert.equal(refreshed.status, 200);
});

test('registered confidential client completes PKCE authorization, callback, redemption and refresh', async () => {
  const registration = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri] }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  assert.equal(client.token_endpoint_auth_method, 'client_secret_post');
  const authorization = await authorize({ client_id: client.client_id, state: 'test-client-state' });
  assert.equal(authorization.status, 302);
  const state = new URL(authorization.headers.get('location')).searchParams.get('state');
  const callback = await fetch(`${baseUrl}/oauth/callback?${new URLSearchParams({ state, code: 'mock-accelo-code' })}`, {
    redirect: 'manual',
  });
  assert.equal(callback.status, 302);
  const destination = new URL(callback.headers.get('location'));
  assert.equal(destination.origin + destination.pathname, redirectUri);
  assert.equal(destination.searchParams.get('state'), 'test-client-state');
  const request = {
    grant_type: 'authorization_code', code: destination.searchParams.get('code'),
    client_id: client.client_id, client_secret: client.client_secret, code_verifier: verifier,
  };
  const response = await token(request);
  assert.equal(response.status, 200);
  const issued = await response.json();
  assert.equal(issued.token_type, 'Bearer');
  const access = db.prepare('SELECT * FROM access_tokens WHERE token = ?').get(issued.access_token);
  assert.equal(access.client_id, client.client_id);
  assert.equal(db.prepare('SELECT * FROM accelo_tokens WHERE subject = ?').get(access.subject).access_token, 'mock-upstream-access');
  assert.equal((await token(request)).status, 400);
  const refreshRequest = {
    grant_type: 'refresh_token', refresh_token: issued.refresh_token,
    client_id: client.client_id, client_secret: client.client_secret,
  };
  const refreshResponse = await token(refreshRequest);
  assert.equal(refreshResponse.status, 200);
  const rotated = await refreshResponse.json();
  assert.notEqual(rotated.refresh_token, issued.refresh_token);
  assert.equal(db.prepare('SELECT * FROM refresh_tokens WHERE token = ?').get(issued.refresh_token), undefined);
  assert.equal(db.prepare('SELECT * FROM access_tokens WHERE token = ?').get(rotated.access_token).subject, access.subject);
  assert.equal((await token(refreshRequest)).status, 400);
  for (const sensitive of [clientSecret, client.client_secret, verifier, request.code, issued.access_token, issued.refresh_token]) {
    assert.ok(!output.includes(sensitive), 'lifecycle logs must not include credentials');
  }
});
