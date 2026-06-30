import { z } from 'zod';
import { config } from './config.js';
import { getValidAcceloToken } from './oauth.js';

// Issues module for the Accelo MCP: issue (ticket) records, profile values
// (custom fields), and scoped activity lists.
//
// Self-contained (own fetch + result helpers) so it does not collide with
// concurrent edits to accelo.js / projects.js / activities.js / mcp.js.
// The only touch-point in mcp.js is a single registerIssueTools(server, subject) call.
//
// Accelo calls "issues" tickets. The REST object lives at /issues and
// /issues/{id}. Profile values include custom fields like:
//   - Project/Issue Folder (field_type: "hyperlink", value is a Google Drive URL)
//   - AI Summary, AI Next Steps (field_type: "text")
//   - Other deployment-specific custom profile fields
// Custom fields are served by get_issue_profile_values, NOT by get_issue /
// list_issues (which return only the core issue record fields below).
//
// Activities are queried via the generic GET /activities endpoint with
// _filters=against(issue(X)) — the nested /issues/{id}/activities endpoint
// does not exist in the Accelo REST API.

const log = (...a) => console.log(new Date().toISOString(), '[issues]', ...a);

// Core issue record fields we request back. Accelo hides most fields unless
// explicitly requested via _fields, and omits null/empty fields from responses.
// Custom/profile fields are intentionally excluded (see get_issue_profile_values).
// Per request, date_due / date_resolved are omitted.
const ISSUE_FIELDS = [
  'id', 'title', 'against_type', 'against_id', 'affiliation', 'contact',
  'company', 'contract', 'standing', 'status', 'priority', 'type', 'class',
  'assignee', 'date_created', 'date_started',
].join(',');

// Accelo object types an issue can be logged "against". Constraining this
// prevents a malformed/injected against_type from being interpolated into the
// filter expression (Gate 2 req #2). Add deployment-specific types as needed.
const AGAINST_TYPES = ['company', 'affiliation', 'job', 'issue', 'prospect', 'contract', 'staff', 'contact'];

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

async function acceloGet(token, pathname, query) {
  const url = new URL(config.acceloBaseUrl + pathname);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = (json && json.meta && json.meta.message) || text;
    log('ERROR GET', pathname, res.status, '-', msg);
    throw new Error(`Accelo API GET ${pathname} failed: ${res.status} ${msg}`);
  }
  return json;
}

// Compose an Accelo _filters expression from structured params + an optional
// raw passthrough. Structured tokens follow Accelo's standard field(value)
// convention (comma-separated). The raw `filters` string (if provided) is
// appended verbatim — it is the guaranteed-correct escape hatch when a
// structured token name does not match this deployment.
function buildIssueFilters({ against_type, against_id, affiliation_id, contract_id, status, standing, issue_type, filters }) {
  const parts = [];
  if (against_type) parts.push(`against_type(${against_type})`);
  if (against_id) parts.push(`against_id(${against_id})`);
  if (affiliation_id) parts.push(`affiliation(${affiliation_id})`);
  if (contract_id) parts.push(`contract(${contract_id})`);
  if (status) parts.push(`status(${status})`);
  if (standing) parts.push(`standing(${standing})`);
  if (issue_type) parts.push(`type(${issue_type})`);
  if (filters) parts.push(filters); // raw passthrough, capped at the schema level
  return parts.join(',');
}

export function registerIssueTools(server, subject) {
  server.tool(
    'get_issue',
    'Get a single Accelo issue (ticket) record by ID. Returns the core record: id, title, against_type, against_id, affiliation, contact, company, contract, standing, status, priority, type, class, assignee, date_created, date_started. Does NOT return custom/profile fields — use get_issue_profile_values for those (e.g. the Project/Issue Folder Drive URL). Read-only.',
    { issue_id: z.string().describe('The Accelo issue (ticket) ID') },
    async ({ issue_id }) => {
      const token = await getValidAcceloToken(subject);
      const json = await acceloGet(token, `/issues/${encodeURIComponent(issue_id)}`, {
        _fields: ISSUE_FIELDS,
      });
      return ok(json.response);
    }
  );

  server.tool(
    'list_issues',
    'List or search Accelo issues (tickets), newest first. Returns only issues the authorized user can see (Accelo applies the user\'s own permissions to every query). Use this to discover an issue_id, then call get_issue / get_issue_profile_values / list_issue_activities for detail. Each structured filter is optional and combinable. The raw `filters` parameter is an advanced escape hatch: it is forwarded VERBATIM to Accelo and BYPASSES the structured-filter scoping above (it can broaden or narrow results in ways the structured params cannot express) — prefer the structured params unless you specifically need raw Accelo _filters syntax. Read-only.',
    {
      against_type: z.enum(AGAINST_TYPES).optional().describe('Object type the issue is logged against, e.g. "company". Pair with against_id.'),
      against_id: z.string().regex(/^\d+$/, 'against_id must be a numeric ID').optional().describe('Numeric ID of the object the issue is against. Pair with against_type.'),
      affiliation_id: z.string().regex(/^\d+$/, 'affiliation_id must be a numeric ID').optional().describe('Numeric affiliation (company/contact link) ID to filter by.'),
      contract_id: z.string().regex(/^\d+$/, 'contract_id must be a numeric ID').optional().describe('Numeric contract (retainer) ID to filter by.'),
      status: z.string().optional().describe('Issue status ID/name to filter by (deployment-specific).'),
      standing: z.string().optional().describe('Issue standing to filter by, e.g. "active", "closed", "resolved".'),
      issue_type: z.string().optional().describe('Issue type ID to filter by (deployment-specific).'),
      search: z.string().max(200).optional().describe('Free-text search (_search) across the issue title. Used sparingly at this firm.'),
      filters: z.string().max(500).optional().describe('ADVANCED: raw Accelo _filters expression forwarded verbatim, e.g. "standing(active),date_created_after(1490140800)". BYPASSES the structured filters above. Max 500 chars.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 50, max 100).'),
      page: z.number().int().min(0).optional().describe('Zero-based page number (default 0).'),
    },
    async (args) => {
      const token = await getValidAcceloToken(subject);
      const lim = args.limit || 50;
      const filterExpr = buildIssueFilters(args);

      const baseQuery = {
        _fields: ISSUE_FIELDS,
        _limit: lim,
        _page: args.page || 0,
      };
      if (args.search) baseQuery._search = args.search;

      // Try with newest-first ordering first (Accelo order-filter syntax varies
      // by deployment); fall back without ordering and sort client-side. Same
      // defensive pattern as list_issue_activities.
      let list;
      try {
        const orderExpr = filterExpr
          ? `${filterExpr},order_by_desc(date_created)`
          : 'order_by_desc(date_created)';
        const json = await acceloGet(token, '/issues', { ...baseQuery, _filters: orderExpr });
        list = Array.isArray(json.response) ? json.response : [];
      } catch (e) {
        log('order filter rejected, retrying without:', e.message);
        const json = await acceloGet(token, '/issues', {
          ...baseQuery,
          ...(filterExpr ? { _filters: filterExpr } : {}),
        });
        list = Array.isArray(json.response) ? json.response : [];
      }

      // Guarantee newest-first regardless of server-side ordering support.
      list.sort((a, b) => Number(b.date_created || 0) - Number(a.date_created || 0));
      return ok(list);
    }
  );

  server.tool(
    'get_issue_profile_values',
    'Get custom profile field values for an Accelo issue (ticket). Returns all profile fields including Project/Issue Folder (a Google Drive URL — extract the Drive folder ID from it), AI Summary, AI Next Steps, and other deployment-specific custom fields. Each value includes field_name, value, field_type, and id. Read-only.',
    { issue_id: z.string().describe('The Accelo issue ID') },
    async ({ issue_id }) => {
      const token = await getValidAcceloToken(subject);
      const json = await acceloGet(token, `/issues/${encodeURIComponent(issue_id)}/profiles/values`, {
        _limit: 100,
      });
      return ok(json.response || []);
    }
  );

  server.tool(
    'list_issue_activities',
    'List recent activities (emails, notes, logged work) against an Accelo issue (ticket), newest first. Returns correspondence context: id, subject, date_created, date_logged, body (email/note text), medium, owner_id, against_type, against_id. Uses the generic /activities endpoint with against(issue(X)) filter. Read-only.',
    {
      issue_id: z.string().describe('The Accelo issue ID'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 50)'),
    },
    async ({ issue_id, limit }) => {
      const token = await getValidAcceloToken(subject);
      const filters = `against(issue(${issue_id}))`;
      const lim = limit || 50;
      const fields = 'id,subject,date_created,date_logged,body,medium,owner_id,against_type,against_id';

      // Try with ordering filter first (Accelo syntax varies by deployment);
      // fall back without ordering and sort client-side.
      let list;
      try {
        const json = await acceloGet(token, '/activities', {
          _filters: `${filters},order_by_desc(date_logged)`,
          _limit: lim,
          _fields: fields,
        });
        list = Array.isArray(json.response) ? json.response : [];
      } catch (e) {
        log('order filter rejected, retrying without:', e.message);
        const json = await acceloGet(token, '/activities', {
          _filters: filters,
          _limit: lim,
          _fields: fields,
        });
        list = Array.isArray(json.response) ? json.response : [];
      }

      // Guarantee newest-first regardless of server-side ordering support.
      list.sort((a, b) =>
        Number(b.date_logged || b.date_created || 0) - Number(a.date_logged || a.date_created || 0)
      );
      return ok(list);
    }
  );
}
