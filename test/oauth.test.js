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

async function waitForOutput(value, start = 0) {
  const deadline = Date.now() + 1000;
  while (!output.slice(start).includes(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(output.slice(start).includes(value), `server log contains ${value}`);
}

let registrationNumber = 0;
async function register(metadata, headers = {}) {
  const ip = `198.51.100.${++registrationNumber}`;
  const start = output.length;
  const response = await new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': `203.0.113.99, ${ip}`,
        ...headers,
      },
    }, (res) => {
      let body = '';
      res.on('data', (data) => { body += data; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.end(JSON.stringify(metadata));
  });
  await waitForOutput('\n', start);
  return { ...response, ip, log: output.slice(start) };
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

function assertNoSentinels(text, values) {
  for (const value of values) {
    assert.ok(!text.includes(value), `output does not include ${value}`);
  }
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
    assertNoSentinels(result.stdout, [
      secret, access, refresh, 'sentinel-expired-access', 'sentinel-expiring-refresh', 'sentinel-expired-refresh',
      clientId, 'other-client', 'public-client', 'legacy-client', privateRedirect, redirectUri,
      'private-callback', 'private-query', 'subject-one', 'subject-two', 'subject-three', 'client_secret',
    ]);
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

function registrySnapshot() {
  return {
    clients: db.prepare('SELECT * FROM clients ORDER BY client_id').all(),
    access: db.prepare('SELECT * FROM access_tokens ORDER BY token').all(),
    refresh: db.prepare('SELECT * FROM refresh_tokens ORDER BY token').all(),
  };
}

function seedPruneRegistry() {
  const now = Date.now();
  const old = now - 100 * 86400000;
  const privateRedirect = 'https://client.example/private-prune-callback?sentinel=private-prune-query';
  db.prepare('UPDATE clients SET created_at = ?, redirect_uris = ?')
    .run(old, JSON.stringify([privateRedirect]));
  db.prepare('UPDATE clients SET redirect_uris = ? WHERE client_id = ?').run('[]', 'public-client');
  const insert = db.prepare(`
    INSERT INTO clients (client_id, redirect_uris, created_at, last_used_at) VALUES (?,?,?,?)
  `);
  insert.run('expired-access-client', JSON.stringify([privateRedirect]), old, null);
  insert.run('expired-refresh-client', JSON.stringify([privateRedirect]), old, null);
  insert.run('observed-client', JSON.stringify([privateRedirect]), old, old);
  insert.run('recent-client', JSON.stringify([privateRedirect]), now - 60000, null);
  seedAccessToken('other-client');
  const expiredAccess = seedAccessToken('expired-access-client');
  db.prepare('UPDATE access_tokens SET expires_at = ? WHERE token = ?').run(now - 1000, expiredAccess);
  seedRefresh('legacy-client', null);
  seedRefresh('expired-refresh-client', now - 1000);
  return registrySnapshot();
}

function assertPruneRedacted(stdout, snapshot) {
  for (const value of [
    ...snapshot.clients.map((row) => row.client_id),
    clientSecret, ...snapshot.access.map((row) => row.token),
    ...snapshot.refresh.map((row) => row.token),
    'test-subject', 'private-prune-callback', 'private-prune-query', 'client_secret',
  ]) {
    assert.ok(!stdout.includes(value), `prune output does not include ${value}`);
  }
}

test('registry prune dry run lists only eligible rows and leaves all three tables unchanged', async () => {
  const before = seedPruneRegistry();
  const script = path.join(root, 'scripts/registry-report.mjs');
  const human = await runNode([script, '--prune']);
  assert.match(human.stdout, /test-cli/);
  assert.match(human.stdout, /public-c/);
  assert.match(human.stdout, /https:\/\/client.example/);
  assert.match(human.stdout, /Total: 2 \| LIVE: 0 \| STALE: 1 \| INERT: 1/);
  assert.match(human.stdout, /Would delete 2 client rows\. Dry run; no changes made\./);
  assert.equal(human.stderr, '');
  assertPruneRedacted(human.stdout, before);
  assert.deepEqual(registrySnapshot(), before);
  for (const days of ['1', '365']) {
    const json = await runNode([script, '--prune', '--json', '--stale-days', days]);
    const preview = JSON.parse(json.stdout);
    const normal = JSON.parse((await runNode([script, '--json', '--stale-days', days])).stdout);
    assert.deepEqual(preview.clients,
      normal.clients.filter((row) => ['test-cli', 'public-c'].includes(row.client_id)));
    assert.equal(preview.would_delete, 2);
    assertPruneRedacted(json.stdout, before);
    assert.deepEqual(registrySnapshot(), before);
  }
});

test('registry prune confirm deletes exactly eligible clients and prints the resulting summary', async () => {
  const before = seedPruneRegistry();
  const result = await runNode([path.join(root, 'scripts/registry-report.mjs'), '--prune', '--confirm']);
  assert.deepEqual(registrySnapshot(), {
    ...before, clients: before.clients.filter((row) => ![clientId, 'public-client'].includes(row.client_id)),
  });
  assert.match(result.stdout, /Deleted 2 client rows\./);
  const summary = JSON.parse((await runNode([path.join(root, 'scripts/registry-report.mjs'), '--json'])).stdout).summary;
  assert.ok(result.stdout.trimEnd().endsWith(
    `Total: ${summary.total} | LIVE: ${summary.LIVE} | STALE: ${summary.STALE} | INERT: ${summary.INERT} | Never observed: ${summary.never_observed}`));
  assert.equal(summary.total, 6);
  assert.equal(result.stderr, '');
  assertPruneRedacted(result.stdout, before);
});

test('registry prune preserves a client holding only an expired access token', async () => {
  const before = seedPruneRegistry();
  await runNode([path.join(root, 'scripts/registry-report.mjs'), '--prune', '--confirm']);
  assert.deepEqual(db.prepare('SELECT * FROM clients WHERE client_id = ?').get('expired-access-client'),
    before.clients.find((row) => row.client_id === 'expired-access-client'));
  assert.deepEqual(registrySnapshot().access, before.access);
});

test('registry prune preserves clients holding only refresh tokens, including expired tokens', async () => {
  const before = seedPruneRegistry();
  await runNode([path.join(root, 'scripts/registry-report.mjs'), '--prune', '--confirm']);
  for (const id of ['legacy-client', 'expired-refresh-client']) {
    assert.deepEqual(db.prepare('SELECT * FROM clients WHERE client_id = ?').get(id),
      before.clients.find((row) => row.client_id === id));
  }
  assert.deepEqual(registrySnapshot().refresh, before.refresh);
});

test('registry prune preserves an observed client with no tokens even when its activity is old', async () => {
  const before = seedPruneRegistry();
  await runNode([path.join(root, 'scripts/registry-report.mjs'), '--prune', '--confirm']);
  assert.deepEqual(db.prepare('SELECT * FROM clients WHERE client_id = ?').get('observed-client'),
    before.clients.find((row) => row.client_id === 'observed-client'));
});

test('registry prune preserves a token-free client registered one minute ago', async () => {
  const before = seedPruneRegistry();
  await runNode([path.join(root, 'scripts/registry-report.mjs'), '--prune', '--confirm']);
  assert.deepEqual(db.prepare('SELECT * FROM clients WHERE client_id = ?').get('recent-client'),
    before.clients.find((row) => row.client_id === 'recent-client'));
});

test('registry confirm without prune fails without changing any registry tables', async () => {
  const before = seedPruneRegistry();
  await assert.rejects(runNode([path.join(root, 'scripts/registry-report.mjs'), '--confirm']), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /^Usage:/);
    return true;
  });
  assert.deepEqual(registrySnapshot(), before);
});

test('registry prune never changes access or refresh token counts or contents', async () => {
  const before = seedPruneRegistry();
  const script = path.join(root, 'scripts/registry-report.mjs');
  for (const flags of [['--prune'], ['--prune', '--confirm'], ['--prune', '--confirm']]) {
    const result = await runNode([script, ...flags, '--json']);
    const report = JSON.parse(result.stdout);
    if (flags.includes('--confirm')) assert.equal(report.remaining_summary.total, 6);
    assertPruneRedacted(result.stdout, before);
    const after = registrySnapshot();
    assert.equal(after.access.length, before.access.length);
    assert.equal(after.refresh.length, before.refresh.length);
    assert.deepEqual(after.access, before.access);
    assert.deepEqual(after.refresh, before.refresh);
  }
});

test('registry prune rolls back the entire deletion set if any deletion fails', async () => {
  const before = seedPruneRegistry();
  db.exec(`
    CREATE TRIGGER reject_prune BEFORE DELETE ON clients WHEN OLD.client_id = 'public-client'
    BEGIN SELECT RAISE(ABORT, 'sentinel-prune-failure'); END;
  `);
  try {
    await assert.rejects(runNode([path.join(root, 'scripts/registry-report.mjs'), '--prune', '--confirm']), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /^Unable to prune the registry\./);
      assert.ok(!error.stderr.includes('sentinel-prune-failure'));
      return true;
    });
    assert.deepEqual(registrySnapshot(), before);
  } finally {
    db.exec('DROP TRIGGER reject_prune');
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

test('successful registration logs the observed source, client prefix, scope, and redirect origins', async () => {
  const result = await register({
    redirect_uris: [redirectUri, 'http://localhost:3080/callback'],
    scope: 'read_only',
  }, { 'User-Agent': 'registration-test' });
  assert.equal(result.status, 201);
  assert.match(result.log, /\[register\] level=info client registered/);
  assert.ok(result.log.includes(`ip="${result.ip}"`));
  assert.ok(!result.log.includes('203.0.113.99'), 'untrusted leftmost forwarded IP is not logged');
  assert.ok(result.log.includes(`client_id=${result.body.client_id.slice(0, 8)} scope=read_only`));
  assert.match(result.log, /user_agent="registration-test"/);
  assert.match(result.log, /redirect_origins=https:\/\/client\.example,http:\/\/localhost:3080/);
  assert.ok(!result.log.includes(result.body.client_id), 'only the client id prefix is logged');
  assert.equal(result.log.split('\n').length, 2);
});

test('registration logs a forged single-entry XFF separately from the true TCP peer', async () => {
  const result = await register({ redirect_uris: [redirectUri] }, {
    'X-Forwarded-For': '203.0.113.9',
  });
  assert.equal(result.status, 201);
  assert.match(result.log, /\[register\] level=info client registered/);
  assert.match(result.log, /ip="203\.0\.113\.9"/);
  assert.match(result.log, /peer="(?:::ffff:)?127\.0\.0\.1"/);
});

test('registration without XFF logs matching client IP and TCP peer', async () => {
  const start = output.length;
  const response = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri] }),
  });
  assert.equal(response.status, 201);
  await waitForOutput('\n', start);
  const log = output.slice(start);
  assert.match(log, /\[register\] level=info client registered/);
  assert.match(log, /peer="(?:::ffff:)?127\.0\.0\.1"/);
  assert.equal(log.match(/ip="([^"]+)"/)[1], log.match(/peer="([^"]+)"/)[1]);
});

test('rejected registration logs the true TCP peer alongside the forwarded IP', async () => {
  for (const metadata of [{}, { redirect_uris: [redirectUri], scope: 'unsupported' }]) {
    const result = await register(metadata, { 'X-Forwarded-For': '203.0.113.9' });
    assert.equal(result.status, 400);
    assert.match(result.log, /\[register\] level=warn rejected/);
    assert.match(result.log, /ip="203\.0\.113\.9"/);
    assert.match(result.log, /peer="(?:::ffff:)?127\.0\.0\.1"/);
  }
});

test('rejected registration logs origin fields and each validation reason', async () => {
  for (const [metadata, reason, origins] of [
    [{ scope: 'unsupported', redirect_uris: [redirectUri] }, 'invalid_client_metadata', 'https://client.example'],
    [{ redirect_uris: [redirectUri, 'http://evil.example/private'] }, 'invalid_redirect_uri', 'https://client.example,(invalid)'],
    [{}, 'invalid_redirect_uri', '(none)'],
    [{ redirect_uris: [null, 42, {}] }, 'invalid_redirect_uri', '(invalid)'],
  ]) {
    const result = await register(metadata, { 'User-Agent': 'rejected-test' });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: reason });
    assert.ok(result.log.includes(`[register] level=warn rejected reason=${reason}`));
    assert.ok(result.log.includes(`ip="${result.ip}" user_agent="rejected-test"`));
    assert.ok(result.log.includes(`redirect_origins=${origins}`));
    assert.equal(result.log.split('\n').length, 2);
  }
});

test('registration strips all C0/C1 controls and neutralizes forged log markers in real emitted output', async () => {
  // HTTP rejects CR/LF headers, so invoke the real handler before the HTTP parser.
  const controls = Array.from({ length: 65 }, (_, i) => String.fromCharCode(i < 32 ? i : i + 95)).join('');
  const userAgent = `agent\r\n[register] forged line${controls}`;
  const ip = '198.51.100.200\r\n[register] forged ip';
  const result = await runNode(['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import express from ${JSON.stringify(new URL('../node_modules/express/index.js', import.meta.url).href)};
    const post = express.application.post;
    let register;
    express.application.post = function(route, ...handlers) {
      if (route === '/register') register = handlers.at(-1);
      return post.call(this, route, ...handlers);
    };
    express.application.listen = () => {};
    await import(${JSON.stringify(new URL('../src/index.js', import.meta.url).href)});
    const { default: db } = await import(${JSON.stringify(new URL('../src/db.js', import.meta.url).href)});
    try {
      register({
        body: {}, ip: ${JSON.stringify(ip)},
        socket: { remoteAddress: ${JSON.stringify(ip)} },
        get: () => ${JSON.stringify(userAgent)},
      }, {
        status(code) { assert.equal(code, 400); return this; },
        json(body) { assert.deepEqual(body, { error: 'invalid_redirect_uri' }); },
      });
    } finally { db.close(); }
  `]);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.split('\n').length, 2, 'exactly one real log line is emitted');
  assert.equal(result.stdout.match(/\[register\]/g).length, 1, 'no injected register marker survives');
  assert.doesNotMatch(result.stdout.slice(0, -1), /[\u0000-\u001f\u007f-\u009f]/);
  assert.ok(result.stdout.includes('user_agent="agent\\u005bregister] forged line"'));
  assert.ok(result.stdout.includes('ip="198.51.100.200\\u005bregister] forged ip"'));
  assert.ok(result.stdout.includes('peer="198.51.100.200\\u005bregister] forged ip"'));
});

test('registration truncates User-Agent to 120 characters after stripping controls in both branches', async () => {
  for (const scope of ['full', 'unsupported']) {
    const result = await register({ redirect_uris: [redirectUri], scope }, {
      'User-Agent': `${'a'.repeat(119)}\tb-tail-must-not-be-logged`,
    });
    assert.equal(result.status, scope === 'full' ? 201 : 400);
    const field = result.log.match(/user_agent=("(?:[^"\\]|\\.)*")/)[1];
    assert.equal(JSON.parse(field), `${'a'.repeat(119)}b`);
    assert.ok(!result.log.includes('tail-must-not-be-logged'));
    assert.doesNotMatch(result.log, /[\t\u0080\u009f]/);
  }
});

test('registration logs a literal dash for missing User-Agent in both branches', async () => {
  for (const metadata of [{ redirect_uris: [redirectUri] }, {}]) {
    const result = await register(metadata);
    assert.equal(result.status, metadata.redirect_uris ? 201 : 400);
    assert.match(result.log, /user_agent="-"/);
  }
});

test('registration success and rejection logs pass the registry-report secret sentinel sweep', async () => {
  const privateRedirect = 'https://client.example/private-callback?sentinel=private-query';
  const hostileRedirect = 'https://evil.example/private-callback?sentinel=private-query#fragment';
  const sentinels = [
    'sentinel-secret-not-a-real-credential', 'sentinel-access-not-a-real-token',
    'sentinel-refresh-not-a-real-token', privateRedirect, hostileRedirect, redirectUri,
    'private-callback', 'private-query', '#fragment',
    'client_secret', 'access_token', 'refresh_token',
  ];
  for (const metadata of [
    { redirect_uris: [privateRedirect] },
    { redirect_uris: [privateRedirect], scope: 'unsupported' },
    { redirect_uris: [privateRedirect, hostileRedirect] },
  ]) {
    const result = await register({
      ...metadata,
      client_secret: sentinels[0], access_token: sentinels[1], refresh_token: sentinels[2],
    });
    assert.equal(result.status, metadata.scope || metadata.redirect_uris.includes(hostileRedirect) ? 400 : 201);
    assertNoSentinels(result.log, [...sentinels, clientSecret, ...(result.body.client_secret ? [result.body.client_secret] : [])]);
    assert.match(result.log, /redirect_origins=https:\/\/client\.example/);
  }
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
  await waitForOutput('redirect_origins=http://localhost:3080');

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
  assert.equal(listedBody.result.tools.length, 30, 'dynamically registered LibreChat clients retain all tools');
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
  assert.equal((await mcpJson(fullList)).result.tools.length, 30);

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

test('read-only clients see only the 19 allowlisted tools and cannot call a write tool', async () => {
  db.prepare('UPDATE clients SET scope = ? WHERE client_id = ?').run('read_only', clientId);
  const access = seedAccessToken(clientId);
  const listed = await mcpRequest(access, 'tools/list');
  assert.equal(listed.status, 200);
  const names = (await mcpJson(listed)).result.tools.map((tool) => tool.name);
  assert.equal(names.length, 19);
  for (const name of [
    'list_activities', 'get_activity', 'get_activity_recipients', 'get_activity_thread',
    'get_issue', 'list_issues', 'get_issue_profile_values', 'list_issue_activities',
    'list_quotes', 'get_quote', 'get_deal', 'get_project_plan', 'list_tasks',
    'get_task', 'list_task_progressions', 'get_project_profile_values', 'list_project_activities',
  ]) {
    assert.ok(names.includes(name), `${name} is registered for read-only clients`);
  }
  for (const name of [
    'create_activity', 'log_note',
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
  assert.equal((await mcpJson(legacyList)).result.tools.length, 30);

  const orphanAccess = seedAccessToken('deleted-client');
  const orphanList = await mcpRequest(orphanAccess, 'tools/list');
  assert.equal((await mcpJson(orphanList)).result.tools.length, 19);
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
