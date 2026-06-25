import { z } from 'zod';
import { config } from './config.js';
import { getValidAcceloToken } from './oauth.js';

// Issues module for the Accelo MCP: profile values (custom fields) and
// scoped activity lists for issues/tickets.
//
// Self-contained (own fetch + result helpers) so it does not collide with
// concurrent edits to accelo.js / projects.js / activities.js / mcp.js.
// The only touch-point in mcp.js is a single registerIssueTools(server, subject) call.
//
// Profile values include custom fields like:
//   - Project/Issue Folder (field_type: "hyperlink", value is a Google Drive URL)
//   - AI Summary, AI Next Steps (field_type: "text")
//   - Other deployment-specific custom profile fields
//
// Activities are queried via the generic GET /activities endpoint with
// _filters=against(issue(X)) \u2014 the nested /issues/{id}/activities endpoint
// does not exist in the Accelo REST API.

const log = (...a) => console.log(new Date().toISOString(), '[issues]', ...a);

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

export function registerIssueTools(server, subject) {
  server.tool(
    'get_issue_profile_values',
    'Get custom profile field values for an Accelo issue (ticket). Returns all profile fields including Project/Issue Folder (a Google Drive URL \u2014 extract the Drive folder ID from it), AI Summary, AI Next Steps, and other deployment-specific custom fields. Each value includes field_name, value, field_type, and id. Read-only.',
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
