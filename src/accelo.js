import { config } from './config.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const log = (...a) => console.log(new Date().toISOString(), '[accelo]', ...a);
const retryBudget = new AsyncLocalStorage();

export function withAcceloRetryBudget(callback) {
  return retryBudget.run({ waitedMs: 0 }, callback);
}

function retryDelay(res, retryNumber) {
  if (res.status === 429) {
    const values = [];
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const date = Date.parse(retryAfter);
      if (Number.isFinite(seconds)) values.push(Math.max(0, seconds * 1000));
      else if (Number.isFinite(date)) values.push(Math.max(0, date - Date.now()));
    }
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) {
      values.push(Math.max(0, reset * 1000 - Date.now()));
    }
    if (values.length) return Math.max(...values);
  }
  return 1000 * (2 ** (retryNumber - 1));
}

// Fields we request back from Accelo for quotes. Accelo hides most fields
// unless explicitly requested via _fields, and omits null/empty fields from
// responses.
//
// READ/WRITE KEY ASYMMETRY (verified against the live API on a draft quote):
//   - Terms & Conditions:  WRITE `terms_and_conditions`  ->  READ `terms`
//   - Portal access flag:  WRITE `client_portal_access`  ->  READ `portal_access`
// We therefore request the READ key names here and normalize the response (see
// normalizeQuote) so callers see the same field names they wrote. Requesting
// the write-side names (e.g. `terms_and_conditions`) returns nothing, which is
// what made a successful T&C write look like a silent drop on verification.
const QUOTE_FIELDS = [
  'id', 'title', 'against_type', 'against_id', 'affiliation_id', 'contact_id',
  'manager_id', 'standing', 'date_created', 'date_modified', 'date_issued',
  'date_due', 'date_expiry', 'total', 'tax', 'subtotal', 'currency_id',
  'notes', 'introduction', 'conclusion', 'terms',
  'portal_access',
].join(',');

// Accelo returns some quote fields under different keys than it accepts on
// write (see QUOTE_FIELDS note). Mirror the write-side aliases onto the read
// result so round-trip verification works by the same field name the agent
// set (e.g. an agent that wrote `terms_and_conditions` can read it back under
// `terms_and_conditions`). The canonical Accelo read keys are preserved too.
function normalizeQuote(q) {
  if (!q || typeof q !== 'object') return q;
  if (q.terms !== undefined && q.terms_and_conditions === undefined) {
    q.terms_and_conditions = q.terms;
  }
  if (q.portal_access !== undefined && q.client_portal_access === undefined) {
    q.client_portal_access = q.portal_access;
  }
  return q;
}

async function acceloFetch(token, pathname, { method = 'GET', query, body, allowError = false } = {}) {
  const url = new URL(config.acceloBaseUrl + pathname);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(body).toString();
  }
  const budget = retryBudget.getStore() || { waitedMs: 0 };
  const canRetry = (status) => method === 'GET'
    ? [429, 502, 503, 504].includes(status)
    : status === 429;
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(url, opts);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (res.ok) return json;

    if (attempt <= 3 && canRetry(res.status)) {
      const backoffMs = retryDelay(res, attempt);
      const remainingMs = Math.max(0, 20000 - budget.waitedMs);
      if (remainingMs > 0) {
        const waitMs = Math.min(backoffMs, remainingMs);
        log('attempt', attempt, 'status', res.status, 'backoff_ms', waitMs);
        budget.waitedMs += waitMs;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        if (waitMs === backoffMs) continue;
      }
    }

    const msg = (json && json.meta && json.meta.message) || text;
    if (allowError) return { ok: false, status: res.status, json, message: msg };
    log('ERROR', 'attempt', attempt, 'status', res.status, 'backoff_ms', 0);
    const error = new Error(`Accelo API ${method} ${pathname} failed: ${res.status} ${msg}`);
    error.status = res.status;
    throw error;
  }
}

export const acceloGet = (token, pathname, query) => acceloFetch(token, pathname, { query });
export const acceloPost = (token, pathname, body) => acceloFetch(token, pathname, { method: 'POST', body });
export const acceloPut = (token, pathname, body) => acceloFetch(token, pathname, { method: 'PUT', body });
export const acceloTryPost = (token, pathname, body) =>
  acceloFetch(token, pathname, { method: 'POST', body, allowError: true });

export async function listQuotes(token, { search, limit = 25, page = 0, filters } = {}) {
  const query = { _fields: QUOTE_FIELDS, _limit: limit, _page: page };
  if (search) query._search = search;
  if (filters) query._filters = filters;
  const json = await acceloFetch(token, '/quotes', { query });
  const list = json.response;
  return Array.isArray(list) ? list.map(normalizeQuote) : list;
}

export async function getQuote(token, id) {
  const json = await acceloFetch(token, `/quotes/${encodeURIComponent(id)}`, {
    query: { _fields: QUOTE_FIELDS },
  });
  return normalizeQuote(json.response);
}

export async function createQuote(token, fields) {
  const json = await acceloFetch(token, '/quotes', { method: 'POST', body: fields });
  return normalizeQuote(json.response);
}

export async function updateQuote(token, id, fields) {
  const json = await acceloFetch(token, `/quotes/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: fields,
  });
  return normalizeQuote(json.response);
}

// Accelo calls deals/sales "prospects". A quote's parent deal is its
// against_id when against_type == "prospect". _fields=_ALL returns the full
// deal record (title, value, standing, date_actioned/date_won, etc).
export async function getDeal(token, id) {
  const json = await acceloFetch(token, `/prospects/${encodeURIComponent(id)}`, {
    query: { _fields: '_ALL' },
  });
  return json.response;
}
