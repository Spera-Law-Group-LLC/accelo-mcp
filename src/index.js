import express from 'express';
import crypto, { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import db from './db.js';
import { buildServer } from './mcp.js';
import { exchangeAcceloCode } from './oauth.js';

const app = express();
// Exactly ONE proxy hop (nginx) sits in front of this service. With trust
// proxy = 1, Express derives the client IP from the rightmost X-Forwarded-For
// entry — the address the nearest trusted proxy actually observed. A client-
// supplied X-Forwarded-For is pushed leftward and ignored, so it cannot be used
// to forge a fresh rate-limit bucket. Do NOT raise this number unless more
// trusted hops are added. (Gate 2 #26.)
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const now = () => Date.now();
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const log = (...a) => console.log(new Date().toISOString(), ...a);
const redirectUriOrigin = (value) => {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
};
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})[char]);
const relativeAge = (createdAt) => {
  const minutes = Math.max(0, Math.floor((now() - createdAt) / 60000));
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

// Refresh tokens live 90 days and rotate on use.
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const ACCESS_TTL_MS = 3600 * 1000;

// ---------------------------------------------------------------------------
// This server is an OAuth proxy: it is an Authorization Server to the MCP
// client (LibreChat), and an OAuth client to Accelo. The MCP client never
// sees the Accelo token; it gets one of our opaque tokens, which we map to a
// stored per-user Accelo token. This keeps Accelo's own permission model.
//
// Logging policy: log lifecycle events and errors only. Never log OAuth
// codes, state values, tokens, or PKCE verifiers.
// ---------------------------------------------------------------------------

// ---- Rate limiting (issue #19) --------------------------------------------
// In-memory store: counters reset on container restart. Acceptable for now;
// there is no Redis in this service. Tracked as a known residual (F2.4).
// keyGenerator uses Express's resolved req.ip (rightmost XFF under trust
// proxy = 1), so a forged X-Forwarded-For cannot rotate the rate-limit key.
const rlOpts = {
  windowMs: 15 * 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
};
const registerLimiter = rateLimit({ ...rlOpts, max: 10 });   // DCR is rare
const authorizeLimiter = rateLimit({ ...rlOpts, max: 30 });  // interactive logins
const tokenLimiter = rateLimit({ ...rlOpts, max: 60 });
const callbackLimiter = rateLimit({ ...rlOpts, max: 60 });

// ---- Discovery ----
app.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.json({
    resource: config.publicBaseUrl,
    authorization_servers: [config.publicBaseUrl],
  });
});

app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.json({
    issuer: config.publicBaseUrl,
    authorization_endpoint: `${config.publicBaseUrl}/authorize`,
    token_endpoint: `${config.publicBaseUrl}/token`,
    registration_endpoint: `${config.publicBaseUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  });
});

// ---- Dynamic Client Registration (RFC 7591) ----
// Intentionally unauthenticated per spec, but rate-limited to prevent table
// flooding. redirect_uris registered here are later enforced at /authorize.
app.post('/register', registerLimiter, (req, res) => {
  const body = req.body || {};
  const requestedScope = body.scope;
  if (requestedScope !== undefined && requestedScope !== 'read_only' && requestedScope !== 'full') {
    return res.status(400).json({ error: 'invalid_client_metadata' });
  }
  const scope = requestedScope === undefined ? 'full' : requestedScope;
  const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!redirect_uris.length || redirect_uris.some((uri) => !redirectUriOrigin(uri))) {
    return res.status(400).json({ error: 'invalid_redirect_uri' });
  }
  const client_id = rand(16);
  const client_secret = rand(24);
  db.prepare('INSERT INTO clients (client_id, client_secret, redirect_uris, created_at, scope) VALUES (?,?,?,?,?)')
    .run(client_id, client_secret, JSON.stringify(redirect_uris), now(), scope);
  const hosts = [...new Set(redirect_uris.map((uri) => new URL(uri).hostname))].join(',');
  log('[register] client registered for redirect host(s):', hosts);
  res.status(201).json({
    client_id,
    client_secret,
    redirect_uris,
    scope,
    token_endpoint_auth_method: 'client_secret_post',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
});

function renderConsentPage(consentId, redirectOrigin, createdAt) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorization request</title></head>
<body>
  <main>
    <h1>Authorization request</h1>
    <p>An <strong>unverified application</strong> is requesting access to your Accelo account.</p>
    <p>Redirect origin: <strong>${escapeHtml(redirectOrigin)}</strong></p>
    <p>Registered ${escapeHtml(relativeAge(createdAt))}.</p>
    <p>Continue only if you recognize this application and expected this request.</p>
    <form method="post" action="/authorize/consent">
      <input type="hidden" name="consent_id" value="${escapeHtml(consentId)}">
      <button type="submit" name="action" value="approve">Continue to Accelo</button>
      <button type="submit" name="action" value="deny">Deny</button>
    </form>
  </main>
</body>
</html>`;
}

function setConsentHeaders(res) {
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
}

function buildAcceloAuthorizationUrl(state) {
  const url = new URL(`${config.acceloOAuthUrl}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.acceloClientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', state);
  return url.toString();
}

// ---- Authorize: validate client + redirect_uri, then require explicit consent ----
app.get('/authorize', authorizeLimiter, (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;
  if (response_type !== 'code') return res.status(400).send('unsupported_response_type');
  if (!client_id) return res.status(400).send('missing client_id');
  if (!redirect_uri) return res.status(400).send('missing redirect_uri');

  const client = db.prepare('SELECT * FROM clients WHERE client_id = ?').get(client_id);
  if (!client) {
    log('[authorize] unauthorized_client');
    return res.status(400).json({ error: 'unauthorized_client' });
  }

  // SECURITY (#21): the redirect_uri MUST be one of the client's registered
  // URIs (exact match). Without this, an attacker who registers a client can
  // point /authorize at their own URL and steal the authorization code.
  let registered = [];
  try {
    registered = JSON.parse(client.redirect_uris || '[]');
  } catch (e) {
    registered = [];
  }
  if (!Array.isArray(registered) || !registered.includes(redirect_uri)) {
    log('[authorize] redirect_uri_mismatch for client', client_id);
    return res.status(400).send('redirect_uri_mismatch');
  }

  if (typeof code_challenge !== 'string' || !code_challenge ||
      (code_challenge_method !== undefined && code_challenge_method !== 'S256')) {
    return res.status(400).send('invalid_request');
  }

  const redirectOrigin = redirectUriOrigin(redirect_uri);
  if (!redirectOrigin) return res.status(400).send('redirect_uri_mismatch');
  const consentId = rand(24);
  db.prepare(
    'INSERT INTO consent_requests (consent_id, client_id, client_redirect_uri, client_state, code_challenge, code_challenge_method, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(consentId, client_id, redirect_uri, state || null, code_challenge, code_challenge_method || 'S256', now());

  setConsentHeaders(res);
  res.type('html').status(200).send(renderConsentPage(consentId, redirectOrigin, client.created_at));
});

app.post('/authorize/consent', authorizeLimiter, (req, res) => {
  const { consent_id: consentId, action } = req.body || {};
  if (typeof consentId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(consentId) ||
      !['approve', 'deny'].includes(action)) {
    return res.status(400).send('invalid consent request');
  }

  const consumeConsentRequest = db.transaction((id) => {
    const pending = db.prepare('SELECT * FROM consent_requests WHERE consent_id = ?').get(id);
    if (pending) db.prepare('DELETE FROM consent_requests WHERE consent_id = ?').run(id);
    return pending;
  });
  const pending = consumeConsentRequest(consentId);
  if (!pending || pending.created_at <= now() - 600000) {
    return res.status(400).send('invalid or expired consent request');
  }

  const client = db.prepare('SELECT * FROM clients WHERE client_id = ?').get(pending.client_id);
  let registered = [];
  try {
    registered = JSON.parse(client?.redirect_uris || '[]');
  } catch {
    registered = [];
  }
  if (!client || !Array.isArray(registered) || !registered.includes(pending.client_redirect_uri) ||
      !redirectUriOrigin(pending.client_redirect_uri)) {
    return res.status(400).send('invalid consent request');
  }

  const redirect = new URL(pending.client_redirect_uri);
  if (action === 'deny') {
    redirect.searchParams.set('error', 'access_denied');
    if (pending.client_state) redirect.searchParams.set('state', pending.client_state);
    log('[authorize] consent denied');
    return res.redirect(redirect.toString());
  }

  const ourState = rand(16);
  db.prepare(
    'INSERT INTO auth_state (state, client_id, client_redirect_uri, client_state, code_challenge, code_challenge_method, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(
    ourState, pending.client_id, pending.client_redirect_uri, pending.client_state,
    pending.code_challenge, pending.code_challenge_method || 'S256', now(),
  );
  log('[authorize] consent granted');
  res.redirect(buildAcceloAuthorizationUrl(ourState));
});

// ---- Accelo redirects back here after the user consents ----
app.get('/oauth/callback', callbackLimiter, async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    // Accelo returns error + error_description (state echoed only if supplied)
    if (error) {
      log('[callback] Accelo returned error:', error, error_description || '');
      return res.status(400).send('Authorization was not completed. Please retry.');
    }

    // Look up by the state Accelo echoed back. Require an explicit state match;
    // the previous "single most-recent pending row" fallback is removed because
    // it could be polluted by an attacker holding open a pending auth_state.
    if (!state) {
      log('[callback] missing state from Accelo');
      return res.status(400).send('invalid state');
    }
    const st = db.prepare('SELECT * FROM auth_state WHERE state = ?').get(state);
    if (!st) {
      log('[callback] no matching auth_state');
      return res.status(400).send('invalid state');
    }
    db.prepare('DELETE FROM auth_state WHERE state = ?').run(st.state);

    if (!code) {
      log('[callback] missing authorization code from Accelo');
      return res.status(400).send('missing authorization code from Accelo');
    }

    const tok = await exchangeAcceloCode(code);
    const subject = randomUUID();
    const expiresAt = now() + (tok.expires_in ? tok.expires_in * 1000 : 3600 * 1000);
    db.prepare(
      'INSERT INTO accelo_tokens (subject, access_token, refresh_token, expires_at, created_at) VALUES (?,?,?,?,?)'
    ).run(subject, tok.access_token, tok.refresh_token || null, expiresAt, now());

    const ourCode = rand(24);
    db.prepare(
      'INSERT INTO auth_codes (code, client_id, redirect_uri, subject, code_challenge, code_challenge_method, expires_at) VALUES (?,?,?,?,?,?,?)'
    ).run(ourCode, st.client_id, st.client_redirect_uri, subject, st.code_challenge, st.code_challenge_method, now() + 600000);

    const back = new URL(st.client_redirect_uri);
    back.searchParams.set('code', ourCode);
    if (st.client_state) back.searchParams.set('state', st.client_state);
    log('[callback] authorization complete for a new subject');
    res.redirect(back.toString());
  } catch (e) {
    // Log detail server-side only; do not leak exception text to the caller (#25).
    log('[callback] ERROR:', e.message);
    res.status(500).send('OAuth callback error. Please retry the authorization.');
  }
});

// ---- Token endpoint ----
function validTokenClient(client_id, client_secret, expectedClientId) {
  if (typeof client_id !== 'string' || !client_id || client_id !== expectedClientId) return false;
  const client = db.prepare('SELECT * FROM clients WHERE client_id = ?').get(client_id);
  if (!client) return false;
  if (client.client_secret === null) return true;
  if (typeof client_secret !== 'string' || !client_secret) return false;
  const supplied = Buffer.from(client_secret);
  const expected = Buffer.from(client.client_secret);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

app.post('/token', tokenLimiter, (req, res) => {
  const { grant_type, code, code_verifier, refresh_token, client_id, client_secret } = req.body;

  if (grant_type === 'authorization_code') {
    const ac = db.prepare('SELECT * FROM auth_codes WHERE code = ?').get(code);
    if (!ac || ac.expires_at < now()) return res.status(400).json({ error: 'invalid_grant' });
    if (!validTokenClient(client_id, client_secret, ac.client_id)) {
      return res.status(400).json({ error: 'invalid_client' });
    }
    if (typeof code_verifier !== 'string' || !code_verifier) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
    const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
    if (hash !== ac.code_challenge) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
    db.prepare('DELETE FROM auth_codes WHERE code = ?').run(code);
    const accessToken = rand(32);
    const refreshToken = rand(32);
    db.prepare('INSERT INTO access_tokens (token, subject, client_id, expires_at) VALUES (?,?,?,?)')
      .run(accessToken, ac.subject, ac.client_id, now() + ACCESS_TTL_MS);
    db.prepare('INSERT INTO refresh_tokens (token, subject, client_id, expires_at) VALUES (?,?,?,?)')
      .run(refreshToken, ac.subject, ac.client_id, now() + REFRESH_TTL_MS);
    return res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600, refresh_token: refreshToken });
  }

  if (grant_type === 'refresh_token') {
    const rt = db.prepare('SELECT * FROM refresh_tokens WHERE token = ?').get(refresh_token);
    // Reject unknown or expired refresh tokens (expires_at may be NULL on
    // legacy rows minted before the migration; treat NULL as still-valid once,
    // then rotate it into an expiring token below).
    if (!rt) return res.status(400).json({ error: 'invalid_grant' });
    if (!validTokenClient(client_id, client_secret, rt.client_id)) {
      return res.status(400).json({ error: 'invalid_client' });
    }
    if (rt.expires_at != null && rt.expires_at < now()) {
      db.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(refresh_token);
      return res.status(400).json({ error: 'invalid_grant', error_description: 'refresh token expired' });
    }
    // ROTATE: invalidate the presented refresh token and issue a new pair.
    db.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(refresh_token);
    const accessToken = rand(32);
    const newRefresh = rand(32);
    db.prepare('INSERT INTO access_tokens (token, subject, client_id, expires_at) VALUES (?,?,?,?)')
      .run(accessToken, rt.subject, rt.client_id, now() + ACCESS_TTL_MS);
    db.prepare('INSERT INTO refresh_tokens (token, subject, client_id, expires_at) VALUES (?,?,?,?)')
      .run(newRefresh, rt.subject, rt.client_id, now() + REFRESH_TTL_MS);
    return res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600, refresh_token: newRefresh });
  }

  res.status(400).json({ error: 'unsupported_grant_type' });
});

// ---- Resolve a Bearer token to a subject ----
function authenticate(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return null;
  const row = db.prepare(`
    SELECT access_tokens.subject, access_tokens.expires_at,
      CASE
        WHEN clients.client_id IS NULL THEN 'read_only'
        WHEN clients.scope = 'read_only' THEN 'read_only'
        ELSE 'full'
      END AS scope
    FROM access_tokens
    LEFT JOIN clients ON clients.client_id = access_tokens.client_id
    WHERE access_tokens.token = ?
  `).get(m[1]);
  if (!row || row.expires_at < now()) return null;
  return { subject: row.subject, scope: row.scope };
}

// ---- MCP endpoint (stateless: one server/transport per request) ----
app.post('/mcp', async (req, res) => {
  const client = authenticate(req);
  if (!client) {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource"`
    );
    return res.status(401).json({ error: 'invalid_token' });
  }
  const server = buildServer(client.subject, client.scope);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---- Periodic cleanup of expired rows (issue #23) -------------------------
function cleanupExpired() {
  const t = now();
  try {
    db.prepare('DELETE FROM access_tokens WHERE expires_at < ?').run(t);
    db.prepare('DELETE FROM refresh_tokens WHERE expires_at IS NOT NULL AND expires_at < ?').run(t);
    db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(t);
    db.prepare('DELETE FROM auth_state WHERE created_at < ?').run(t - 600000);
    db.prepare('DELETE FROM consent_requests WHERE created_at < ?').run(t - 600000);
  } catch (e) {
    log('[cleanup] error:', e.message);
  }
}
cleanupExpired();
setInterval(cleanupExpired, 60 * 60 * 1000).unref();

app.listen(config.port, '0.0.0.0', () => {
  console.log(`accelo-mcp listening on 0.0.0.0:${config.port}`);
});
