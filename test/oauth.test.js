import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';

const root = fileURLToPath(new URL('../', import.meta.url));
const clientId = 'test-client';
const clientSecret = randomBytes(24).toString('base64url');
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const redirectUri = 'https://client.example/callback';
const execFileAsync = promisify(execFile);
let directory, db, child, upstream, baseUrl;
let output = '';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'accelo-mcp-oauth-'));
  const tokenDbPath = path.join(directory, 'tokens.db');
  const legacyDb = new Database(tokenDbPath);
  legacyDb.exec(`
    CREATE TABLE clients (
      client_id TEXT PRIMARY KEY,
      client_secret TEXT,
      redirect_uris TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  legacyDb.prepare('INSERT INTO clients VALUES (?,?,?,?)')
    .run('legacy-client', null, JSON.stringify([redirectUri]), Date.now());
  legacyDb.close();
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
      TOKEN_DB_PATH: tokenDbPath,
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
  db = new Database(tokenDbPath);
  const scopeColumn = db.prepare('PRAGMA table_info(clients)').all().find((column) => column.name === 'scope');
  assert.ok(scopeColumn, 'opening an existing database adds clients.scope');
  assert.equal(db.prepare('SELECT scope FROM clients WHERE client_id = ?').get('legacy-client').scope, null);
  assert.equal(db.prepare('SELECT last_used_at FROM clients WHERE client_id = ?').get('legacy-client').last_used_at, null);
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
  for (const table of ['clients', 'auth_state', 'consent_requests', 'auth_codes', 'access_tokens', 'refresh_tokens', 'accelo_tokens']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  const insert = db.prepare('INSERT INTO clients (client_id, client_secret, redirect_uris, created_at) VALUES (?,?,?,?)');
  insert.run(clientId, clientSecret, JSON.stringify([redirectUri]), Date.now());
  insert.run('other-client', clientSecret, JSON.stringify([redirectUri]), Date.now());
  insert.run('public-client', null, JSON.stringify([redirectUri]), Date.now());
  insert.run('legacy-client', null, JSON.stringify([redirectUri]), Date.now());
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

async function consent(response, action = 'approve') {
  const html = await response.text();
  const match = html.match(/name="consent_id" value="([A-Za-z0-9_-]+)"/);
  assert.ok(match, 'consent page includes its hidden consent id');
  const submitted = await fetch(`${baseUrl}/authorize/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ consent_id: match[1], action }),
    redirect: 'manual',
  });
  return { consentId: match[1], response: submitted };
}

function token(body) {
  return fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

function mcpRequest(accessToken, method, params = {}) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
}

async function mcpJson(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  const text = await response.text();
  const data = text.split(/\r?\n/).find((line) => line.startsWith('data: '));
  assert.ok(data, `MCP response has no data event: ${text}`);
  return JSON.parse(data.slice(6));
}

async function waitForOutput(value) {
  const deadline = Date.now() + 1000;
  while (!output.includes(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(output.includes(value), `server log contains ${value}`);
}

function seedAccessToken(id) {
  const access = randomUUID();
  db.prepare('INSERT INTO access_tokens (token, subject, client_id, expires_at) VALUES (?,?,?,?)')
    .run(access, 'test-subject', id, Date.now() + 600000);
  return access;
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

function runNode(args, tokenDbPath = path.join(directory, 'tokens.db')) {
  return execFileAsync(process.execPath, args, {
    cwd: directory,
    env: {
      ...process.env,
      PUBLIC_BASE_URL: baseUrl,
      ACCELO_CLIENT_ID: 'mock-upstream-client',
      ACCELO_CLIENT_SECRET: clientSecret,
      TOKEN_DB_PATH: tokenDbPath,
    },
  });
}

function lastUsed(id = clientId) {
  return db.prepare('SELECT last_used_at FROM clients WHERE client_id = ?').get(id).last_used_at;
}

test('last-use migration is idempotent and preserves pre-existing clients without backfill', async () => {
  const filename = path.join(directory, 'migration.db');
  const legacy = new Database(filename);
  const original = {
    client_id: 'pre-existing-client',
    client_secret: null,
    redirect_uris: JSON.stringify([redirectUri]),
    created_at: Date.now() - 86400000,
  };
  legacy.exec(`CREATE TABLE clients (
    client_id TEXT PRIMARY KEY, client_secret TEXT, redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  legacy.prepare('INSERT INTO clients VALUES (@client_id, @client_secret, @redirect_uris, @created_at)').run(original);
  legacy.close();
  const moduleUrl = new URL('../src/db.js', import.meta.url).href;
  for (let i = 0; i < 2; i++) {
    await runNode(['--input-type=module', '--eval', `import db from ${JSON.stringify(moduleUrl)}; db.close();`], filename);
    const migrated = new Database(filename, { readonly: true });
    try {
      assert.equal(migrated.prepare('PRAGMA table_info(clients)').all()
        .filter((column) => column.name === 'last_used_at').length, 1);
      assert.deepEqual(migrated.prepare('SELECT * FROM clients').get(), {
        ...original, scope: null, last_used_at: null,
      });
    } finally {
      migrated.close();
    }
  }
});

test('successful authorization-code issuance sets last use and refresh rotation advances it', async () => {
  const started = Date.now();
  const response = await token({
    grant_type: 'authorization_code', code: seedCode(), code_verifier: verifier,
    client_id: clientId, client_secret: clientSecret,
  });
  assert.equal(response.status, 200);
  const issued = await response.json();
  assert.ok(lastUsed() >= started && lastUsed() <= Date.now());
  assert.equal(lastUsed('other-client'), null);
  const old = Date.now() - 120000;
  db.prepare('UPDATE clients SET last_used_at = ? WHERE client_id = ?').run(old, clientId);
  const refreshed = await token({
    grant_type: 'refresh_token', refresh_token: issued.refresh_token,
    client_id: clientId, client_secret: clientSecret,
  });
  assert.equal(refreshed.status, 200);
  assert.ok(lastUsed() > old);
  assert.equal(db.prepare('SELECT token FROM refresh_tokens WHERE token = ?').get(issued.refresh_token), undefined);
});

test('authenticated MCP requests advance last use with only one write inside a minute', async () => {
  const access = seedAccessToken(clientId);
  const old = Date.now() - 120000;
  db.prepare('UPDATE clients SET last_used_at = ? WHERE client_id = ?').run(old, clientId);
  db.exec(`
    CREATE TABLE activity_writes (written_at INTEGER);
    CREATE TRIGGER count_activity_writes AFTER UPDATE OF last_used_at ON clients
    BEGIN INSERT INTO activity_writes VALUES (NEW.last_used_at); END;
  `);
  try {
    assert.equal((await mcpRequest(access, 'tools/list')).status, 200);
    const observed = lastUsed();
    assert.ok(observed > old);
    assert.equal((await mcpRequest(access, 'tools/list')).status, 200);
    assert.equal(lastUsed(), observed);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activity_writes').get().count, 1);
    assert.equal(lastUsed('other-client'), null);
  } finally {
    db.exec('DROP TRIGGER count_activity_writes; DROP TABLE activity_writes;');
  }
});

test('failed MCP authentication does not record client activity', async () => {
  const access = seedAccessToken(clientId);
  db.prepare('UPDATE access_tokens SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, access);
  for (const value of ['unknown-token', access]) {
    assert.equal((await mcpRequest(value, 'tools/list')).status, 401);
    assert.equal(lastUsed(), null);
  }
});

test('registry report is read-only, classifies clients, counts tokens, and redacts both output formats', async () => {
  const secret = 'sentinel-secret-not-a-real-credential';
  const access = 'sentinel-access-not-a-real-token';
  const refresh = 'sentinel-refresh-not-a-real-token';
  const privateRedirect = 'https://client.example/private-callback?sentinel=private-query';
  const now = Date.now();
  db.prepare('UPDATE clients SET client_secret = ?').run(secret);
  db.prepare('UPDATE clients SET redirect_uris = ?, scope = ? WHERE client_id = ?')
    .run(JSON.stringify([privateRedirect, redirectUri, 'http://localhost:3080/callback']), 'read_only', clientId);
  db.prepare('UPDATE clients SET redirect_uris = ? WHERE client_id = ?').run('[]', 'public-client');
  db.prepare('UPDATE clients SET last_used_at = ? WHERE client_id = ?').run(now, 'legacy-client');
  const old = now - 100 * 86400000;
  db.prepare('UPDATE clients SET last_used_at = ? WHERE client_id = ?').run(old, clientId);
  db.prepare('UPDATE clients SET last_used_at = ? WHERE client_id = ?').run(now - 30 * 86400000, 'other-client');
  db.prepare('INSERT INTO access_tokens VALUES (?,?,?,?)').run(access, 'subject-one', clientId, now + 600000);
  db.prepare('INSERT INTO access_tokens VALUES (?,?,?,?)').run('sentinel-expired-access', 'subject-two', clientId, now - 1000);
  db.prepare('INSERT INTO refresh_tokens VALUES (?,?,?,?)').run(refresh, 'subject-one', clientId, null);
  db.prepare('INSERT INTO refresh_tokens VALUES (?,?,?,?)')
    .run('sentinel-expiring-refresh', 'subject-two', clientId, now + 600000);
  db.prepare('INSERT INTO refresh_tokens VALUES (?,?,?,?)')
    .run('sentinel-expired-refresh', 'subject-three', 'legacy-client', now - 1000);
  const snapshot = () => ({
    clients: db.prepare('SELECT * FROM clients ORDER BY client_id').all(),
    access: db.prepare('SELECT * FROM access_tokens ORDER BY token').all(),
    refresh: db.prepare('SELECT * FROM refresh_tokens ORDER BY token').all(),
  });
  const before = snapshot();
  const script = path.join(root, 'scripts/registry-report.mjs');
  const json = await runNode([script, '--json']);
  const report = JSON.parse(json.stdout);
  assert.deepEqual(report.clients.map((row) => row.client_id),
    ['legacy-c', 'other-cl', 'test-cli', 'public-c']);
  const live = report.clients.find((row) => row.client_id === clientId.slice(0, 8));
  assert.deepEqual(live, {
    client_id: 'test-cli',
    redirect_origins: 'https://client.example, http://localhost:3080',
    scope: 'read_only',
    created_at: new Date(before.clients.find((row) => row.client_id === clientId).created_at).toISOString(),
    last_used_at: new Date(old).toISOString(),
    access: 1, refresh: 2, subjects: 2, flags: 'LIVE',
  });
  assert.equal(report.clients.find((row) => row.client_id === 'legacy-c').scope, 'full');
  const inert = report.clients.find((row) => row.client_id === 'public-c');
  assert.equal(inert.flags, 'INERT');
  assert.equal(inert.redirect_origins, '(none)');
  assert.equal(inert.last_used_at, 'never observed');
  assert.deepEqual(report.summary, { total: 4, LIVE: 3, STALE: 0, INERT: 1, never_observed: 1 });
  const custom = JSON.parse((await runNode([script, '--json', '--stale-days', '7'])).stdout);
  assert.equal(custom.clients.find((row) => row.client_id === 'other-cl').flags, 'STALE');
  db.prepare('UPDATE clients SET last_used_at = ? WHERE client_id = ?').run(old, 'other-client');
  const aged = JSON.parse((await runNode([script, '--json'])).stdout);
  assert.equal(aged.clients.find((row) => row.client_id === 'other-cl').flags, 'STALE');
  db.prepare('UPDATE clients SET last_used_at = NULL WHERE client_id = ?').run('other-client');
  const neverUsed = JSON.parse((await runNode([script, '--json'])).stdout);
  assert.equal(neverUsed.clients.find((row) => row.client_id === 'other-cl').flags, 'STALE');
  assert.deepEqual(neverUsed.summary, { total: 4, LIVE: 2, STALE: 1, INERT: 1, never_observed: 2 });
  db.prepare('UPDATE clients SET last_used_at = ? WHERE client_id = ?').run(now - 30 * 86400000, 'other-client');
  const human = await runNode([script]);
  assert.match(human.stdout, /Total: 4 \| LIVE: 3 \| STALE: 0 \| INERT: 1 \| Never observed: 1/);
  for (const result of [json, human]) {
    assert.equal(result.stderr, '');
    for (const value of [
      secret, access, refresh, 'sentinel-expired-access', 'sentinel-expiring-refresh', 'sentinel-expired-refresh',
      clientId, 'other-client', 'public-client', 'legacy-client', privateRedirect, redirectUri,
      'private-callback', 'private-query', 'subject-one', 'subject-two', 'subject-three', 'client_secret',
    ]) {
      assert.ok(!result.stdout.includes(value), `report does not include ${value}`);
    }
  }
  assert.deepEqual(snapshot(), before);
});

test('registry report rejects invalid options without echoing their values', async () => {
  const script = path.join(root, 'scripts/registry-report.mjs');
  for (const args of [
    ['--stale-days', '0'], ['--stale-days', '-1'], ['--stale-days', '1.5'],
    ['--stale-days', 'Infinity'], ['--stale-days'], ['--unknown-sentinel'],
  ]) {
    await assert.rejects(runNode([script, ...args]), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /^Usage:/);
      assert.ok(!error.stderr.includes('unknown-sentinel'));
      return true;
    });
  }
});

test('unknown authorization client is rejected without changing clients or auth state', async () => {
  const clients = db.prepare('SELECT * FROM clients ORDER BY client_id').all();
  const response = await authorize({ client_id: 'unknown-client' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'unauthorized_client' });
  assert.deepEqual(db.prepare('SELECT * FROM clients ORDER BY client_id').all(), clients);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_state').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM consent_requests').get().count, 0);
});

for (const [name, metadata] of [
  ['missing redirect URIs', {}],
  ['empty redirect URIs', { redirect_uris: [] }],
  ['non-local HTTP redirect URI', { redirect_uris: ['http://evil.example/cb'] }],
]) {
  test(`dynamic registration rejects ${name}`, async () => {
    const response = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_redirect_uri' });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM clients').get().count, 4);
  });
}

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
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM consent_requests').get().count, 0);
  });
}

test('registered redirect matching is still exact', async () => {
  const response = await authorize({ redirect_uri: `${redirectUri}/other` });
  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'redirect_uri_mismatch');
});

test('authorize renders consent without reaching Accelo and defaults the stored challenge method to S256', async () => {
  const response = await authorize({ code_challenge_method: undefined });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'unsafe-inline'");
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const html = await response.text();
  assert.match(html, /unverified application/i);
  assert.match(html, /https:\/\/client\.example/);
  assert.match(html, /Registered less than a minute ago/);
  assert.ok(!html.includes(clientId), 'opaque client id is not shown to the user');
  assert.ok(html.indexOf('value="deny"') < html.indexOf('value="approve"'), 'Deny is the first form action');
  assert.match(html, /class="deny"[^>]*>Deny/);
  assert.match(html, /\.deny\s*\{[^}]*font-weight:\s*700/s);
  assert.match(html, /\.approve\s*\{[^}]*text-decoration:\s*underline/s);
  const row = db.prepare('SELECT * FROM consent_requests').get();
  assert.equal(row.code_challenge, challenge);
  assert.equal(row.code_challenge_method, 'S256');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_state').get().count, 0);
});

test('localhost HTTP redirect URI is accepted while a hostile URI path is not rendered', async () => {
  const localRedirect = 'http://localhost:3080/cb';
  const registration = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [localRedirect] }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  await waitForOutput('[register] client registered for redirect host(s): localhost:3080');

  const hostileRedirect = 'https://client.example/"><script>alert(1)</script>';
  db.prepare('UPDATE clients SET redirect_uris = ? WHERE client_id = ?')
    .run(JSON.stringify([hostileRedirect]), client.client_id);
  const authorization = await authorize({
    client_id: client.client_id,
    redirect_uri: hostileRedirect,
  });
  assert.equal(authorization.status, 200);
  const html = await authorization.text();
  assert.ok(!html.includes('"><script>'), 'hostile path markup is not emitted raw');
  assert.ok(!html.includes(hostileRedirect), 'the full redirect URI is not rendered');
  assert.match(html, /https:\/\/client\.example/);
});

test('consent approval is single-use and only then creates auth state for the Accelo redirect', async () => {
  const authorization = await authorize({ state: 'test-client-state' });
  assert.equal(authorization.status, 200);
  assert.equal(lastUsed(), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_state').get().count, 0);
  const { consentId, response: approved } = await consent(authorization);
  assert.equal(approved.status, 302);
  assert.equal(lastUsed(), null);
  const acceloUrl = new URL(approved.headers.get('location'));
  assert.equal(acceloUrl.origin, `http://127.0.0.1:${upstream.address().port}`);
  const state = acceloUrl.searchParams.get('state');
  const row = db.prepare('SELECT * FROM auth_state WHERE state = ?').get(state);
  assert.equal(row.client_id, clientId);
  assert.equal(row.client_state, 'test-client-state');
  assert.equal(row.code_challenge_method, 'S256');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM consent_requests').get().count, 0);
  await waitForOutput('[authorize] consent granted for redirect host: client.example');
  assert.equal((await fetch(`${baseUrl}/authorize/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ consent_id: consentId, action: 'approve' }),
    redirect: 'manual',
  })).status, 400);
});

test('consent denial redirects with access_denied and never creates auth state', async () => {
  const authorization = await authorize({ state: 'denied-state' });
  const { response: denied } = await consent(authorization, 'deny');
  assert.equal(denied.status, 302);
  const destination = new URL(denied.headers.get('location'));
  assert.equal(destination.origin + destination.pathname, redirectUri);
  assert.equal(destination.searchParams.get('error'), 'access_denied');
  assert.equal(destination.searchParams.get('state'), 'denied-state');
  await waitForOutput('[authorize] consent denied for redirect host: client.example');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_state').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM consent_requests').get().count, 0);
});

test('expired consent requests cannot create auth state', async () => {
  const authorization = await authorize();
  const html = await authorization.text();
  const consentId = html.match(/name="consent_id" value="([A-Za-z0-9_-]+)"/)[1];
  db.prepare('UPDATE consent_requests SET created_at = ? WHERE consent_id = ?').run(Date.now() - 600001, consentId);
  const response = await fetch(`${baseUrl}/authorize/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ consent_id: consentId, action: 'approve' }),
  });
  assert.equal(response.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_state').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM consent_requests').get().count, 0);
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
      assert.equal(lastUsed(), null);
      assert.equal(lastUsed('other-client'), null);
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
    assert.equal(lastUsed(), null);
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
  assert.equal(client.scope, 'full');
  assert.equal(client.token_endpoint_auth_method, 'client_secret_post');
  const authorization = await authorize({ client_id: client.client_id, state: 'test-client-state' });
  assert.equal(authorization.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_state').get().count, 0);
  const { response: approved } = await consent(authorization);
  assert.equal(approved.status, 302);
  const state = new URL(approved.headers.get('location')).searchParams.get('state');
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
  const listed = await mcpRequest(issued.access_token, 'tools/list');
  assert.equal(listed.status, 200);
  const listedBody = await mcpJson(listed);
  assert.equal(listedBody.result.tools.length, 31, 'dynamically registered LibreChat clients retain all tools');
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

test('dynamic registration accepts supported scopes and defaults absent scope to full', async () => {
  const readonlyResponse = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], scope: 'read_only' }),
  });
  assert.equal(readonlyResponse.status, 201);
  const readonlyClient = await readonlyResponse.json();
  assert.equal(readonlyClient.scope, 'read_only');
  assert.equal(db.prepare('SELECT scope FROM clients WHERE client_id = ?').get(readonlyClient.client_id).scope, 'read_only');

  const fullResponse = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], scope: 'full' }),
  });
  assert.equal(fullResponse.status, 201);
  const fullClient = await fullResponse.json();
  assert.equal(fullClient.scope, 'full');
  const fullAccess = seedAccessToken(fullClient.client_id);
  const fullList = await mcpRequest(fullAccess, 'tools/list');
  assert.equal((await mcpJson(fullList)).result.tools.length, 31);

  const defaultResponse = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://localhost:3080/cb'] }),
  });
  assert.equal(defaultResponse.status, 201);
  const defaultClient = await defaultResponse.json();
  assert.equal(defaultClient.scope, 'full');
  assert.deepEqual(defaultClient.redirect_uris, ['http://localhost:3080/cb']);

  const invalidResponse = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], scope: 'write_all' }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.deepEqual(await invalidResponse.json(), { error: 'invalid_client_metadata' });
});

test('read-only clients see only the 17 allowlisted tools and cannot call a write tool', async () => {
  db.prepare('UPDATE clients SET scope = ? WHERE client_id = ?').run('read_only', clientId);
  const access = seedAccessToken(clientId);
  const listed = await mcpRequest(access, 'tools/list');
  assert.equal(listed.status, 200);
  const names = (await mcpJson(listed)).result.tools.map((tool) => tool.name);
  assert.equal(names.length, 17);
  for (const name of [
    'list_activities', 'get_activity', 'get_activity_recipients', 'get_activity_thread',
    'get_issue', 'list_issues', 'get_issue_profile_values', 'list_issue_activities',
    'list_quotes', 'get_quote', 'get_deal', 'get_project_plan', 'list_tasks',
    'get_task', 'list_task_progressions', 'get_project_profile_values', 'list_project_activities',
  ]) {
    assert.ok(names.includes(name), `${name} is registered for read-only clients`);
  }
  for (const name of [
    'create_activity', 'log_note', 'log_email', 'reply_to_activity', 'log_time',
    'create_quote', 'update_quote', 'trigger_quote_template', 'update_task',
    'create_task', 'update_milestone', 'reschedule_plan', 'progress_task', 'cancel_task',
  ]) {
    assert.ok(!names.includes(name), `${name} is withheld from read-only clients`);
  }

  const called = await mcpRequest(access, 'tools/call', {
    name: 'log_note',
    arguments: { against_type: 'job', against_id: '1', subject: 'test', body: 'test', confirm: true },
  });
  assert.equal(called.status, 200);
  const result = await mcpJson(called);
  assert.match(JSON.stringify(result), /not found/i);
  assert.ok(!JSON.stringify(result).includes('confirmation_required'));
});

test('legacy NULL-scope and dangling-client tokens resolve to the intended capabilities', async () => {
  const legacyAccess = seedAccessToken('legacy-client');
  const legacyList = await mcpRequest(legacyAccess, 'tools/list');
  assert.equal((await mcpJson(legacyList)).result.tools.length, 31);

  const orphanAccess = seedAccessToken('deleted-client');
  const orphanList = await mcpRequest(orphanAccess, 'tools/list');
  assert.equal((await mcpJson(orphanList)).result.tools.length, 17);
});

test('full-scope write tools preserve the confirm:true preview response', async () => {
  const access = seedAccessToken(clientId);
  const called = await mcpRequest(access, 'tools/call', {
    name: 'log_note',
    arguments: { against_type: 'job', against_id: '1', subject: 'test', body: 'test' },
  });
  const result = await mcpJson(called);
  assert.equal(result.result.content[0].text, JSON.stringify({
    status: 'confirmation_required',
    message: 'This will LOG a note in Accelo. Review the details below with the user, then call this tool again with confirm: true to proceed.',
    pending: {
      against: 'job(1)',
      medium: 'note',
      subject: 'test',
      body: 'test',
      visibility: 'all',
      class: '13',
      reply_to_parent_id: null,
    },
  }, null, 2));
});
