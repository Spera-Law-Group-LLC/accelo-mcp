import { config } from './config.js';

const log = (...a) => console.log(new Date().toISOString(), '[accelo]', ...a);

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

async function acceloFetch(token, pathname, { method = 'GET', query, body } = {}) {
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
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = (json && json.meta && json.meta.message) || text;
    // Log the failing method + path + status + Accelo message (no token/body).
    log('ERROR', method, pathname, res.status, '-', msg);
    throw new Error(`Accelo API ${method} ${pathname} failed: ${res.status} ${msg}`);
  }
  return json;
}

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
