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
// Activities returned by list_issue_activities use the issue-scoped endpoint
// GET /issues/{id}/activities (simpler than the global /activities with _filters).

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
    'List recent activities (emails, notes, logged work) against an Accelo issue (ticket), newest first. Returns correspondence context: id, subject, date_created, body (email/note text), staff, against_type, against_id. Simpler alternative to list_activities when you already have an issue_id. Read-only.',
    {
      issue_id: z.string().describe('The Accelo issue ID'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 25)'),
    },
    async ({ issue_id, limit }) => {
      const token = await getValidAcceloToken(subject);
      const json = await acceloGet(
        token,
        `/issues/${encodeURIComponent(issue_id)}/activities`,
        {
          _limit: limit || 25,
          _order_by: 'date_created desc',
          _fields: 'id,subject,date_created,body,staff,against_type,against_id',
        }
      );
      const list = Array.isArray(json.response) ? json.response : [];
      return ok(list);
    }
  );
}
