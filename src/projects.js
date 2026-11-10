import { z } from 'zod';
import { config } from './config.js';
import { getValidAcceloToken } from './oauth.js';
import { fetchWindow } from './pagination.js';
import { acceloGet, acceloPost, acceloPut, acceloTryPost } from './accelo.js';

// Project-planning module for the Accelo MCP.
//
// Reads:  list_jobs, get_job, get_project_plan, list_tasks, get_task,
//         list_task_progressions, get_project_profile_values,
//         list_project_activities.
// Writes (confirm:true-guarded): update_task, create_task, progress_task,
//   cancel_task, reschedule_plan (bulk tasks).
//
// Kept deliberately self-contained (its own fetch helpers + MCP result helper)
// so it does not collide with concurrent edits to accelo.js / mcp.js. The only
// touch-point in mcp.js is a single registerProjectTools(server, subject) call.
//
// Accelo model notes (verified live against job 862, 2026-06):
//   - Job (/jobs/{id}) -> Milestones (/jobs/{id}/milestones) -> Tasks (/tasks).
//   - A task is attached via against_type/against_id. Usually against a
//     milestone, but it CAN be against the job directly (not every task has a
//     milestone), so we query both against(milestone(X)) and against(job(X)).
//   - MILESTONES ARE READ-ONLY VIA THE API. Verified live: every write shape
//     returns 400 "resource endpoint was not recognized" -- flat
//     PUT /milestones/{id} AND job-scoped PUT /jobs/{job_id}/milestones/{id}.
//     Accelo exposes no milestone update endpoint. Milestone dates DERIVE from
//     their child tasks (recalculated by Accelo's planner, and not necessarily
//     instantly on an API task write). => To move a milestone, reschedule its
//     TASKS; the milestone follows. Reads: GET /milestones/{id} (single) and
//     GET /milestones?_filters=job({job_id}) (list).
//   - There are NO dependency fields in the REST API. `ordering` is only the
//     display row within a milestone/job and is mostly-but-not-always linear;
//     it is NOT a dependency model. Authoritative cascades require Accelo's
//     GUI engine (future Playwright phase). These write tools are single-object
//     only -- they do NOT cascade downstream tasks.
//   - Planned schedule = date_started / date_due. Actuals = date_commenced /
//     date_completed. All dates are Unix timestamps (seconds). Accelo requires
//     a start date to create a task.
//   - TIMEZONE: Accelo anchors dates to the DEPLOYMENT timezone (US Central /
//     New Orleans => America/Chicago). e.g. raw 1781456400 = 2026-06-15 00:00
//     CDT. Reading that stamp in UTC yields 2026-06-15 05:00 -> slicing gave
//     2026-06-14 (off-by-one). We therefore format reads in ACCELO_TIMEZONE and
//     write a YYYY-MM-DD as NOON in ACCELO_TIMEZONE so it round-trips. Override
//     via env ACCELO_TIMEZONE (default America/Chicago).
//   - STATUS CHANGES REQUIRE PROGRESSIONS. Direct task_status writes via PUT are
//     silently ignored by Accelo. Use list_task_progressions to discover the
//     available progression IDs for a task, then progress_task to run one.
//   - Known status IDs in this deployment: 6 = Cancelled, 8 = Task for Client,
//     12 = Task for Third Party. Cancelling runs PROGRESSION 14 (-> status 6).
//   - CONCURRENCY: firing many parallel write tools overwhelms the container
//     (each update = 3 Accelo calls) and stampedes token refresh. For multi-item
//     changes use reschedule_plan, which processes everything SEQUENTIALLY in a
//     single call.
//   - ACTIVITIES: the nested /jobs/{id}/activities endpoint does NOT exist in
//     the Accelo REST API. list_project_activities uses the generic
//     GET /activities with _filters=against(job(X)) + fan-out across milestones.
//     Activities are NEVER filed against_type='task' in this deployment (verified
//     via DataSights: against_type distribution has 0 task rows), so no task
//     fan-out is needed. For comprehensive historical analysis, use the
//     DataSights AcceloActivitiesDetailsAndInteracts view (syncs overnight ~3 AM
//     CST) which already rolls milestone activities up to the job level.

const log = (...a) => console.log(new Date().toISOString(), '[projects]', ...a);

const TZ = process.env.ACCELO_TIMEZONE || 'America/Chicago';

const WAITING_STATUS = { '8': 'Task for Client', '12': 'Task for Third Party' };
const STATUS_LABELS = { '6': 'Cancelled', '8': 'Task for Client', '12': 'Task for Third Party' };
const CANCELLED_STATUS = '6';
const CANCEL_PROGRESSION_ID = '14';

const JOB_FIELDS = [
  'id', 'title', 'standing', 'job_status', 'manager', 'against', 'against_type',
  'against_id', 'company', 'affiliation', 'date_started', 'date_due',
  'date_commenced', 'date_completed', 'comments',
].join(',');

const MILESTONE_FIELDS = [
  'id', 'title', 'standing', 'milestone_status', 'ordering', 'date_started',
  'date_due', 'date_commenced', 'date_completed', 'manager', 'description',
  'job', 'against', 'against_id', 'against_type',
].join(',');

const TASK_FIELDS = [
  'id', 'title', 'standing', 'status', 'task_status', 'ordering', 'against_type',
  'against_id', 'milestone', 'job', 'assignee', 'manager', 'date_started',
  'date_due', 'date_commenced', 'date_completed', 'description', 'task_priority',
].join(',');

// Fields for activity queries (lean set — no html_body/preview_body).
const ACTIVITY_LIST_FIELDS = [
  'id', 'subject', 'date_created', 'date_logged', 'body', 'medium',
  'owner_id', 'against_type', 'against_id', 'visibility', 'standing',
].join(',');

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function jobUrl(id) {
  const apiUrl = new URL(config.acceloBaseUrl);
  apiUrl.hostname = apiUrl.hostname.replace(/\.api\.accelo\.com$/, '.accelo.com');
  return new URL(`/?action=view_job&id=${encodeURIComponent(id)}`, apiUrl.origin).toString();
}

function relationId(value) {
  if (value && typeof value === 'object') return value.id ?? value.company_id ?? null;
  return value ?? null;
}

function jobCompanyIds(job) {
  if (!job || typeof job !== 'object') return [];
  const ids = [];
  if (job.against_type === 'company' && job.against_id != null) ids.push(job.against_id);
  const companyId = relationId(job.company) ?? job.company_id;
  if (companyId != null) ids.push(companyId);
  const affiliationCompanyId = job.affiliation?.company_id ?? relationId(job.affiliation?.company);
  if (affiliationCompanyId != null) ids.push(affiliationCompanyId);
  return ids.map(String);
}

function companyMismatchCount(rows, companyId) {
  return rows.filter((job) => {
    const companyIds = jobCompanyIds(job);
    return companyIds.length === 0 || companyIds.some((id) => id !== String(companyId));
  }).length;
}

function profileValues(rows, fieldId) {
  return rows
    .map((row) => {
      const valueId = row.value_id ?? row.id ?? null;
      return {
        ...row,
        field_id: row.field_id ?? row.profile_field_id ?? row.field?.id ?? row.profile_field?.id ?? null,
        value_id: valueId,
        id: valueId,
        field_name: row.field_name ?? row.profile_field_name ?? row.field?.name ?? row.profile_field?.name ?? null,
        field_type: row.field_type ?? row.profile_field_type ?? row.field?.type ?? row.profile_field?.type ?? null,
      };
    })
    .filter((row) => fieldId === undefined || String(row.field_id) === fieldId);
}

// Human-in-the-loop guard: returned when a write tool is called without
// confirm:true. Includes a before/after diff so the agent can show the user
// exactly what will change before re-calling with confirm:true.
function needsConfirmation(action, diff) {
  return ok({
    status: 'confirmation_required',
    message: `This will ${action} in Accelo. Review the change below with the user, then call this tool again with confirm: true to proceed.`,
    change: diff,
  });
}

// Run a task progression. Accelo deployments differ on the exact endpoint
// shape, so we try the plain progression endpoint then the /auto variant and
// return whichever succeeds (or a combined error if both fail).
async function runProgression(token, taskId, progressionId) {
  const candidates = [
    `/tasks/${encodeURIComponent(taskId)}/progressions/${encodeURIComponent(progressionId)}`,
    `/tasks/${encodeURIComponent(taskId)}/progressions/${encodeURIComponent(progressionId)}/auto`,
  ];
  const errors = [];
  for (const p of candidates) {
    const r = await acceloTryPost(token, p, {});
    if (r.ok) return { path: p, response: r.json };
    errors.push(`${p} -> ${r.status} ${r.message}`);
  }
  throw new Error(`Progression ${progressionId} on task ${taskId} failed. Tried: ${errors.join(' | ')}`);
}

// ---------------------------------------------------------------------------
// Timezone-aware date helpers (deployment TZ = ACCELO_TIMEZONE)
// ---------------------------------------------------------------------------

// Offset (ms) of TZ at a given UTC instant. Positive = ahead of UTC.
function tzOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  let hour = map.hour === '24' ? '00' : map.hour;
  const asUTC = Date.UTC(map.year, Number(map.month) - 1, map.day, hour, map.minute, map.second);
  return asUTC - utcMs;
}

// Format a Unix-seconds timestamp as a YYYY-MM-DD calendar date IN the
// deployment timezone (so Accelo's TZ-anchored dates read back correctly).
function tsToISO(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(n * 1000));
}

// Convert a YYYY-MM-DD to Unix seconds at NOON in the deployment timezone. Noon
// (not midnight) keeps the calendar date stable against any DST/boundary edge.
// Also accepts raw 10-digit Unix seconds unchanged.
function toUnixSeconds(input) {
  if (input === undefined || input === null || input === '') return undefined;
  const s = String(input).trim();
  if (/^\d{10}$/.test(s)) return s; // already unix seconds
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const [, y, mo, d] = m;
    // Guess noon UTC, then correct by the TZ offset at that instant so the
    // wall-clock time is noon in TZ.
    const noonUTC = Date.UTC(Number(y), Number(mo) - 1, Number(d), 12, 0, 0);
    const offset = tzOffsetMs(noonUTC, TZ);
    return String(Math.floor((noonUTC - offset) / 1000));
  }
  const ms = Date.parse(s);
  if (!Number.isNaN(ms)) return String(Math.floor(ms / 1000));
  throw new Error(`Unrecognized date: "${input}". Use YYYY-MM-DD or Unix seconds.`);
}

function byOrdering(a, b) {
  return Number(a.ordering || 0) - Number(b.ordering || 0);
}

function statusLabel(s) {
  return STATUS_LABELS[String(s)] ? `${s} (${STATUS_LABELS[String(s)]})` : String(s);
}

// Derive the parent job id from a milestone record (fields differ by Accelo
// version: job, against_id, or against="jobs/{id}").
function milestoneJobId(m) {
  if (m && m.job && String(m.job) !== '0') return String(m.job);
  if (m && m.against_id && String(m.against_id) !== '0') return String(m.against_id);
  if (m && typeof m.against === 'string' && m.against.includes('/')) return m.against.split('/')[1];
  return null;
}

function decorateTask(t) {
  return {
    id: t.id,
    title: t.title,
    ordering: t.ordering,
    standing: t.standing,
    task_status: t.task_status,
    waiting_on: WAITING_STATUS[String(t.task_status)] || null,
    cancelled: String(t.task_status) === CANCELLED_STATUS,
    against_type: t.against_type,
    against_id: t.against_id,
    milestone: t.milestone,
    assignee: t.assignee,
    planned_start: tsToISO(t.date_started),
    planned_due: tsToISO(t.date_due),
    actual_commenced: tsToISO(t.date_commenced),
    actual_completed: tsToISO(t.date_completed),
    task_priority: t.task_priority,
    // Raw timestamps retained so write tools (later phases) can compute offsets.
    _raw: {
      date_started: t.date_started,
      date_due: t.date_due,
      date_commenced: t.date_commenced,
      date_completed: t.date_completed,
    },
  };
}

function decorateMilestone(m) {
  return {
    id: m.id,
    title: m.title,
    ordering: m.ordering,
    standing: m.standing,
    job: milestoneJobId(m),
    planned_start: tsToISO(m.date_started),
    planned_due: tsToISO(m.date_due),
    actual_commenced: tsToISO(m.date_commenced),
    actual_completed: tsToISO(m.date_completed),
    // Milestone dates are read-only and DERIVE from child tasks; to move a
    // milestone, reschedule its tasks.
    note: 'milestone dates are read-only via API; they derive from child tasks',
  };
}

async function getTask(token, id) {
  const json = await acceloGet(token, `/tasks/${encodeURIComponent(id)}`, { _fields: TASK_FIELDS });
  return json.response || null;
}

async function fetchTasksAgainst(token, type, id) {
  const json = await acceloGet(token, '/tasks', {
    _filters: `against(${type}(${id}))`,
    _fields: TASK_FIELDS,
    _limit: 100,
  });
  const list = Array.isArray(json.response) ? json.response : [];
  return list.sort(byOrdering).map(decorateTask);
}

async function getProjectPlan(token, jobId) {
  const job = (await acceloGet(token, `/jobs/${encodeURIComponent(jobId)}`, { _fields: JOB_FIELDS })).response;
  const msResp = await acceloGet(token, `/jobs/${encodeURIComponent(jobId)}/milestones`, {
    _fields: MILESTONE_FIELDS,
    _limit: 100,
  });
  const milestones = (Array.isArray(msResp.response) ? msResp.response : []).sort(byOrdering);

  const milestoneNodes = [];
  for (const m of milestones) {
    const tasks = await fetchTasksAgainst(token, 'milestone', m.id);
    milestoneNodes.push({ ...decorateMilestone(m), tasks });
  }

  const jobTasks = await fetchTasksAgainst(token, 'job', jobId);

  const waiting = [];
  for (const mn of milestoneNodes) {
    for (const t of mn.tasks) {
      if (t.waiting_on) waiting.push({ task_id: t.id, title: t.title, waiting_on: t.waiting_on, milestone: mn.title, planned_due: t.planned_due });
    }
  }
  for (const t of jobTasks) {
    if (t.waiting_on) waiting.push({ task_id: t.id, title: t.title, waiting_on: t.waiting_on, milestone: null, planned_due: t.planned_due });
  }

  return {
    job: job ? {
      id: job.id,
      title: job.title,
      against: job.against,
      against_type: job.against_type,
      against_id: job.against_id,
      company: job.company,
      affiliation: job.affiliation,
      standing: job.standing,
      job_status: job.job_status,
      manager: job.manager,
      planned_start: tsToISO(job.date_started),
      planned_due: tsToISO(job.date_due),
      date_started: job.date_started,
      date_completed: job.date_completed,
    } : { id: jobId, note: 'job record not returned' },
    milestones: milestoneNodes,
    job_level_tasks: jobTasks,
    waiting_summary: waiting,
  };
}

// ---------------------------------------------------------------------------
// Activity fan-out helpers
// ---------------------------------------------------------------------------

// Query activities for a single against_type/against_id with ordering. Tries
// the server-side order filter; falls back and sorts client-side if rejected.
async function queryActivitiesFor(token, againstType, againstId, limit, page) {
  const filters = `against(${againstType}(${againstId}))`;
  try {
    const json = await acceloGet(token, '/activities', {
      _filters: `${filters},order_by_desc(date_logged)`,
      _limit: limit,
      _page: page,
      _fields: ACTIVITY_LIST_FIELDS,
    });
    return Array.isArray(json.response) ? json.response : [];
  } catch (e) {
    // Order filter rejected on this deployment -- retry without.
    log('order filter rejected for', againstType, againstId, '- retrying:', e.message);
    const json = await acceloGet(token, '/activities', {
      _filters: filters,
      _limit: limit,
      _page: page,
      _fields: ACTIVITY_LIST_FIELDS,
    });
    return Array.isArray(json.response) ? json.response : [];
  }
}

async function fetchActivitySource(token, againstType, againstId, needed) {
  const limit = Math.min(100, needed + 1);
  const activities = [];
  let page = 0;
  let failedPage = null;

  while (activities.length < needed + 1) {
    try {
      const rows = await queryActivitiesFor(token, againstType, againstId, limit, page);
      activities.push(...rows);
      if (rows.length < limit) break;
      page += 1;
    } catch (e) {
      log('activity query failed for', againstType, againstId, 'page', page, '-', e.message);
      failedPage = page;
      break;
    }
  }

  return {
    activities: activities.slice(0, needed),
    capped: activities.length > needed,
    failedPage,
  };
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

function buildTaskDiff(current, body) {
  const diff = {};
  const isoFields = { date_started: 'planned_start', date_due: 'planned_due' };
  for (const [k, to] of Object.entries(body)) {
    if (isoFields[k]) diff[isoFields[k]] = { from: tsToISO(current[k]), to: tsToISO(to) };
    else diff[k] = { from: current[k], to };
  }
  return diff;
}

// Build the {date_started?, date_due?, title?} write body from a task plan item.
function planItemBody(item) {
  const body = {};
  if (item.title !== undefined) body.title = item.title;
  if (item.planned_start !== undefined) body.date_started = toUnixSeconds(item.planned_start);
  if (item.planned_due !== undefined) body.date_due = toUnixSeconds(item.planned_due);
  return body;
}

// Register all project tools (read + write) onto an existing McpServer.
export function registerProjectTools(server, subject) {
  // -------- Reads --------
  server.tool(
    'list_jobs',
    'List Accelo jobs for a company, returning company references, standing, status, dates, and a stable Accelo link. Pages are zero-based; when has_more is true, request the next page with the same limit. Read-only.',
    {
      company_id: z.string().regex(/^\d+$/, 'company_id must be a numeric ID').describe('Numeric Accelo company ID'),
      standing: z.array(z.enum(['active', 'inactive', 'paused', 'closed', 'complete'])).optional()
        .describe('Optional standings to include; values are passed through as Accelo returns them.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max jobs per page (default 50)'),
      page: z.number().int().min(0).max(10000).optional().describe('Zero-based page number (default 0)'),
    },
    async ({ company_id, standing, limit = 50, page = 0 }) => {
      const token = await getValidAcceloToken(subject);
      const filters = ['against_type(company)', `against_id(${company_id})`];
      if (standing?.length) filters.push(`standing(${standing.join('|')})`);

      // Accelo's company filter expression must be verified against the live
      // API before relying on it; returned company references are checked below.
      let mismatchCount = 0;
      let total;
      async function fetchJobs(upstreamPage, size) {
        const json = await acceloGet(token, '/jobs', {
          _fields: JOB_FIELDS,
          _filters: filters.join(','),
          _limit: size,
          _page: upstreamPage,
        });
        const rows = Array.isArray(json.response) ? json.response : [];
        mismatchCount = companyMismatchCount(rows, company_id);
        if (total == null) total = json.meta?.total ?? json.total;
        return mismatchCount > 0 ? [] : rows;
      }

      const window = await fetchWindow(fetchJobs, limit, page);
      if (mismatchCount > 0) {
        return ok({ status: 'filter_not_applied', mismatch_count: mismatchCount });
      }
      const jobs = window.slice(0, limit).map((job) => ({
        id: job.id,
        title: job.title,
        against_type: job.against_type,
        against_id: job.against_id,
        company: job.company,
        company_id: relationId(job.company) ?? job.company_id ?? (job.against_type === 'company' ? job.against_id : undefined),
        affiliation: job.affiliation,
        affiliation_id: relationId(job.affiliation) ?? job.affiliation_id,
        standing: job.standing,
        job_status: job.job_status,
        date_started: job.date_started,
        date_completed: job.date_completed,
        url: jobUrl(job.id),
      }));
      const result = { jobs, page, limit, has_more: window.length > limit };
      if (total != null) result.total = total;
      return ok(result);
    }
  );

  server.tool(
    'get_job',
    'Get a single Accelo job by ID, including its company reference, standing, status, dates, and stable Accelo link. Read-only.',
    { job_id: z.string().regex(/^\d+$/, 'job_id must be a numeric ID').describe('Numeric Accelo job ID') },
    async ({ job_id }) => {
      const token = await getValidAcceloToken(subject);
      let json;
      try {
        json = await acceloGet(token, `/jobs/${encodeURIComponent(job_id)}`, { _fields: JOB_FIELDS });
      } catch (error) {
        // Accelo returned 400 for a nonexistent job ID when verified live on 2026-11-10; 401/403 still surface.
        if (error.status === 400 || error.status === 404) return ok({ status: 'not_found', object_type: 'job' });
        throw error;
      }
      const job = Array.isArray(json.response) ? json.response[0] : json.response;
      if (!job || job.id == null) return ok({ status: 'not_found', object_type: 'job' });
      return ok({
        id: job.id,
        title: job.title,
        against: job.against,
        against_type: job.against_type,
        against_id: job.against_id,
        company: job.company,
        company_id: relationId(job.company) ?? job.company_id ?? (job.against_type === 'company' ? job.against_id : undefined),
        affiliation: job.affiliation,
        affiliation_id: relationId(job.affiliation) ?? job.affiliation_id,
        standing: job.standing,
        job_status: job.job_status,
        date_started: job.date_started,
        date_completed: job.date_completed,
        url: jobUrl(job.id),
      });
    }
  );

  server.tool(
    'get_project_plan',
    'Get the full project plan for an Accelo job: the job, its milestones (ordered), the tasks under each milestone (ordered), any tasks attached directly to the job, and a waiting_summary of tasks currently waiting on a client or third party (native task_status 8/12). Dates are shown as ISO (YYYY-MM-DD) planned vs actual, in the deployment timezone. Milestone dates are read-only and derive from their tasks. Read-only.',
    { job_id: z.string().describe('The Accelo job (project) ID, e.g. "862"') },
    async ({ job_id }) => {
      const token = await getValidAcceloToken(subject);
      return ok(await getProjectPlan(token, job_id));
    }
  );

  server.tool(
    'list_tasks',
    'List tasks in Accelo, ordered by their plan row. Provide milestone_id to get the tasks under a milestone, or job_id to get tasks attached directly to a job. Exactly one of milestone_id or job_id is required. Read-only.',
    {
      milestone_id: z.string().optional().describe('Milestone ID to list tasks for'),
      job_id: z.string().optional().describe('Job ID to list tasks attached directly to the job'),
    },
    async ({ milestone_id, job_id }) => {
      if (!milestone_id && !job_id) {
        return ok({ status: 'error', message: 'Provide either milestone_id or job_id.' });
      }
      const token = await getValidAcceloToken(subject);
      const type = milestone_id ? 'milestone' : 'job';
      const id = milestone_id || job_id;
      return ok(await fetchTasksAgainst(token, type, id));
    }
  );

  server.tool(
    'get_task',
    'Get a single Accelo task by ID, with ISO planned/actual dates (deployment timezone) and a waiting_on flag (task_status 8/12) and a cancelled flag (task_status 6). Read-only.',
    { id: z.string().describe('The task ID') },
    async ({ id }) => {
      const token = await getValidAcceloToken(subject);
      const t = await getTask(token, id);
      return ok(t ? decorateTask(t) : { status: 'error', message: 'Task not found' });
    }
  );

  server.tool(
    'list_task_progressions',
    'List the progressions available for a task. In Accelo, a task\'s status cannot be set directly via update -- you must run a PROGRESSION, which transitions the task to a new status. Use this to discover the available progression IDs and the status each leads to, then call progress_task. Read-only.',
    { task_id: z.string().describe('The task ID to list progressions for') },
    async ({ task_id }) => {
      const token = await getValidAcceloToken(subject);
      const json = await acceloGet(token, `/tasks/${encodeURIComponent(task_id)}/progressions`, { _fields: '_ALL', _limit: 100 });
      return ok(json.response || []);
    }
  );

  server.tool(
    'get_project_profile_values',
    'Get custom profile field values for a project (job). Returns all profile fields including Project/Issue Folder (a Google Drive URL \u2014 extract the Drive folder ID from it), AI Summary, AI Next Steps, and other deployment-specific custom fields. Each value includes field_id (definition ID), value_id (value-record ID), field_name, value, field_type, and id as a back-compat alias of value_id. Read-only.',
    {
      job_id: z.string().describe('The Accelo job (project) ID'),
      field_id: z.string().regex(/^\d+$/, 'field_id must be a numeric ID').optional().describe('Return only this profile-field definition ID'),
    },
    async ({ job_id, field_id }) => {
      const token = await getValidAcceloToken(subject);
      const json = await acceloGet(token, `/jobs/${encodeURIComponent(job_id)}/profiles/values`, {
        _fields: 'id,value,field_id,field_name,field_type',
        _limit: 100,
      });
      return ok(profileValues(Array.isArray(json.response) ? json.response : [], field_id));
    }
  );

  server.tool(
    'list_project_activities',
    'List recent activities across an ENTIRE project: the job itself AND all its milestones. Fans out sequentially across the job + each milestone to capture the full activity stream (emails, notes, meetings, calls). Activities in Accelo are never filed against_type="task" in this deployment, so job + milestones covers the complete tree. Returns id, subject, date_created, date_logged, body, medium, owner_id, against_type, against_id, visibility. Deduped by activity_id, newest first. Pages are zero-based (default 0); when has_more is true, request the next page with the same limit. activities_gathered is the deduped prefix fetched through this page\'s lookahead, not a project total; sources_capped names sources with more activities beyond the gathered window, and partial/sources_failed disclose failed sources. Best for recent/today activities (real-time from the API). For comprehensive HISTORICAL analysis, use DataSights SQL with the AcceloActivitiesDetailsAndInteracts view (which already rolls milestone activities up to the job level), but note DataSights syncs overnight ~3 AM CST. Read-only.',
    {
      job_id: z.string().describe('The Accelo job (project) ID'),
      limit: z.number().int().min(1).max(100).optional().describe('Max total results after merge (default 50)'),
      page: z.number().int().min(0).max(10000).optional().describe('Zero-based page number (default 0)'),
    },
    async ({ job_id, limit, page = 0 }) => {
      const token = await getValidAcceloToken(subject);
      const lim = limit || 50;
      const start = page * lim;
      const needed = start + lim + 1;

      // 1. Get milestone IDs for this job.
      const milestoneIds = [];
      const sourcesFailed = [];
      let milestonePage = 0;
      while (true) {
        let milestones;
        try {
          const msResp = await acceloGet(token, `/jobs/${encodeURIComponent(job_id)}/milestones`, {
            _fields: 'id',
            _limit: 100,
            _page: milestonePage,
          });
          milestones = Array.isArray(msResp.response) ? msResp.response : [];
        } catch (e) {
          log('milestone fetch failed for job', job_id, 'page', milestonePage, '-', e.message);
          sourcesFailed.push({ source: `milestones(job:${job_id})`, page: milestonePage });
          break;
        }
        milestoneIds.push(...milestones.map((m) => m.id));
        if (milestones.length < 100) break;
        milestonePage += 1;
      }

      // 2. Fan out: job + each milestone (sequential to respect rate limits).
      const allActivities = [];
      const sourcesCapped = [];

      // Job-level activities.
      const jobSource = await fetchActivitySource(token, 'job', job_id, needed);
      allActivities.push(...jobSource.activities);
      if (jobSource.capped) sourcesCapped.push(`job(${job_id})`);
      if (jobSource.failedPage !== null) {
        sourcesFailed.push({ source: `job(${job_id})`, page: jobSource.failedPage });
      }

      // Milestone-level activities (sequential).
      for (const msId of milestoneIds) {
        const msSource = await fetchActivitySource(token, 'milestone', msId, needed);
        allActivities.push(...msSource.activities);
        if (msSource.capped) sourcesCapped.push(`milestone(${msId})`);
        if (msSource.failedPage !== null) {
          sourcesFailed.push({ source: `milestone(${msId})`, page: msSource.failedPage });
        }
      }

      // 3. Dedup by activity_id.
      const seen = new Set();
      const deduped = allActivities.filter((a) => {
        const aid = String(a.id || '');
        if (!aid || seen.has(aid)) return false;
        seen.add(aid);
        return true;
      });

      // 4. Sort newest-first and return this page plus a lookahead row.
      deduped.sort((a, b) =>
        Number(b.date_logged || b.date_created || 0) - Number(a.date_logged || a.date_created || 0)
      );
      const window = deduped.slice(start, start + lim + 1);

      return ok({
        job_id,
        page,
        limit: lim,
        milestones_scanned: milestoneIds.length,
        activities_gathered: deduped.length,
        has_more: window.length > lim,
        sources_capped: sourcesCapped,
        sources_failed: sourcesFailed,
        partial: sourcesFailed.length > 0,
        datasights_note: 'For comprehensive historical analysis, use DataSights SQL: SELECT * FROM AcceloActivitiesDetailsAndInteracts WHERE against_object = \'job\' AND against_id = \'<job_id>\' ORDER BY activity_created_date DESC. DataSights syncs overnight ~3 AM CST.',
        activities: window.slice(0, lim),
      });
    }
  );

  // -------- Writes (confirm:true-guarded; single-object, no cascade) --------

  server.tool(
    'update_task',
    'Update a single Accelo task\'s title and/or planned dates. WRITE OPERATION: requires confirm:true. First call (no confirm) returns a before/after diff; call again with confirm:true to apply. Only the provided fields change. Dates accept YYYY-MM-DD (interpreted in the deployment timezone). NOTE: this does NOT change task STATUS -- Accelo ignores direct status writes; use progress_task (or cancel_task) for status transitions. Single-task edit -- does NOT cascade. To change MANY tasks at once, use reschedule_plan (do NOT fire many update_task calls in parallel -- that overwhelms the server).',
    {
      id: z.string().describe('The task ID to update'),
      title: z.string().optional().describe('New task title'),
      planned_start: z.string().optional().describe('New planned start date as YYYY-MM-DD (or Unix seconds)'),
      planned_due: z.string().optional().describe('New planned due date as YYYY-MM-DD (or Unix seconds)'),
      confirm: z.boolean().optional().describe('Must be true to apply. Omit/false to preview the diff only.'),
    },
    async ({ id, title, planned_start, planned_due, confirm }) => {
      const token = await getValidAcceloToken(subject);
      const body = {};
      if (title !== undefined) body.title = title;
      if (planned_start !== undefined) body.date_started = toUnixSeconds(planned_start);
      if (planned_due !== undefined) body.date_due = toUnixSeconds(planned_due);
      if (Object.keys(body).length === 0) {
        return ok({ status: 'error', message: 'No updatable fields provided (title, planned_start, planned_due).' });
      }
      const current = await getTask(token, id);
      if (!current) return ok({ status: 'error', message: `Task ${id} not found.` });
      const diff = buildTaskDiff(current, body);
      if (confirm !== true) return needsConfirmation(`UPDATE task ${id} ("${current.title}")`, diff);
      await acceloPut(token, `/tasks/${encodeURIComponent(id)}`, body);
      // Re-GET so the response reflects the true stored dates (the write
      // response can omit/return null for date fields).
      const after = await getTask(token, id);
      return ok({ status: 'updated', task: after ? decorateTask(after) : null, applied: diff });
    }
  );

  server.tool(
    'create_task',
    'Create a new Accelo task against a milestone OR a job. WRITE OPERATION: requires confirm:true. First call (no confirm) previews the payload; call again with confirm:true to create. Exactly one of milestone_id or job_id is required. Accelo REQUIRES a start date -- provide planned_start (YYYY-MM-DD, deployment timezone). After creation the task is re-fetched so the response shows the true stored dates.',
    {
      title: z.string().describe('Task title'),
      milestone_id: z.string().optional().describe('Milestone ID to attach the task to'),
      job_id: z.string().optional().describe('Job ID to attach the task directly to (when not under a milestone)'),
      planned_start: z.string().describe('Planned start date as YYYY-MM-DD (REQUIRED by Accelo)'),
      planned_due: z.string().optional().describe('Planned due date as YYYY-MM-DD (or Unix seconds)'),
      assignee_id: z.string().optional().describe('Staff ID to assign the task to'),
      confirm: z.boolean().optional().describe('Must be true to create. Omit/false to preview only.'),
    },
    async ({ title, milestone_id, job_id, planned_start, planned_due, assignee_id, confirm }) => {
      if (!milestone_id && !job_id) return ok({ status: 'error', message: 'Provide either milestone_id or job_id.' });
      if (milestone_id && job_id) return ok({ status: 'error', message: 'Provide only one of milestone_id or job_id.' });
      const token = await getValidAcceloToken(subject);
      const body = {
        title,
        against_type: milestone_id ? 'milestone' : 'job',
        against_id: milestone_id || job_id,
        date_started: toUnixSeconds(planned_start),
      };
      if (planned_due !== undefined) body.date_due = toUnixSeconds(planned_due);
      if (assignee_id !== undefined) body.assignee = assignee_id;
      const preview = {
        title,
        against: `${body.against_type}(${body.against_id})`,
        planned_start: tsToISO(body.date_started),
        planned_due: planned_due ? tsToISO(body.date_due) : undefined,
        assignee_id,
      };
      if (confirm !== true) return needsConfirmation('CREATE a new task', preview);
      const res = await acceloPost(token, '/tasks', body);
      const newId = res.response && res.response.id;
      const after = newId ? await getTask(token, newId) : res.response;
      return ok({ status: 'created', task: after ? decorateTask(after) : res.response });
    }
  );

  server.tool(
    'update_milestone',
    'NOT SUPPORTED by the Accelo API: milestones cannot be written via REST (every PUT shape returns 400). Milestone dates DERIVE from their child tasks. To move a milestone, reschedule its TASKS (update_task or reschedule_plan) and Accelo recalculates the milestone. This tool returns guidance only and never writes.',
    {
      id: z.string().optional().describe('The milestone ID (for reference only)'),
    },
    async ({ id }) => {
      const token = await getValidAcceloToken(subject);
      // Best-effort: list the milestone's tasks so the agent can reschedule them.
      let tasks = [];
      try { if (id) tasks = await fetchTasksAgainst(token, 'milestone', id); } catch (e) { /* ignore */ }
      return ok({
        status: 'not_supported',
        message: 'Milestones are read-only via the Accelo API. Milestone dates derive from their child tasks. To move this milestone, reschedule its tasks with update_task (single) or reschedule_plan (bulk); Accelo will recalculate the milestone dates.',
        milestone_id: id || null,
        tasks_in_milestone: tasks.map((t) => ({ id: t.id, title: t.title, planned_start: t.planned_start, planned_due: t.planned_due })),
      });
    }
  );

  server.tool(
    'reschedule_plan',
    'Bulk-update many TASKS (titles and/or planned dates) in ONE call. WRITE OPERATION: requires confirm:true. The server processes every task SEQUENTIALLY (one Accelo write at a time), so this is the correct way to reschedule a project plan -- do NOT fire many parallel update_task calls (that overwhelms the server). First call (no confirm) returns a combined before/after diff for every task; second call with confirm:true applies them in order and returns a per-task result summary (one failure does not abort the rest). Dates are YYYY-MM-DD in the deployment timezone. NOTE: milestones are NOT updated here -- they are read-only via the API and their dates derive from their child tasks; reschedule the tasks and Accelo recalculates the milestones. Does NOT cascade dependencies -- you supply the exact target dates for each task.',
    {
      tasks: z.array(z.object({
        id: z.string().describe('Task ID'),
        title: z.string().optional().describe('New title'),
        planned_start: z.string().optional().describe('New planned start YYYY-MM-DD'),
        planned_due: z.string().optional().describe('New planned due YYYY-MM-DD'),
      })).describe('Tasks to update'),
      confirm: z.boolean().optional().describe('Must be true to apply. Omit/false to preview the combined diff only.'),
    },
    async ({ tasks, confirm }) => {
      const token = await getValidAcceloToken(subject);
      const taskItems = Array.isArray(tasks) ? tasks : [];
      if (!taskItems.length) {
        return ok({ status: 'error', message: 'Provide a tasks array. (Milestones are read-only and derive from their tasks.)' });
      }

      // ----- Preview: sequential GETs to build a combined diff -----
      if (confirm !== true) {
        const taskDiffs = [];
        for (const it of taskItems) {
          try {
            const body = planItemBody(it);
            if (!Object.keys(body).length) { taskDiffs.push({ id: it.id, error: 'no fields to update' }); continue; }
            const cur = await getTask(token, it.id);
            if (!cur) { taskDiffs.push({ id: it.id, error: 'not found' }); continue; }
            taskDiffs.push({ id: it.id, title: cur.title, change: buildTaskDiff(cur, body) });
          } catch (e) { taskDiffs.push({ id: it.id, error: e.message }); }
        }
        return ok({
          status: 'confirmation_required',
          message: `This will update ${taskItems.length} task(s) in Accelo, sequentially. Milestones are not written (they derive from their tasks). Review the combined diff with the user, then call again with confirm: true.`,
          tasks: taskDiffs,
        });
      }

      // ----- Apply: sequential writes, per-item try/catch -----
      const results = [];
      let applied = 0, failed = 0;
      for (const it of taskItems) {
        try {
          const body = planItemBody(it);
          if (!Object.keys(body).length) { results.push({ type: 'task', id: it.id, ok: false, error: 'no fields to update' }); failed++; continue; }
          await acceloPut(token, `/tasks/${encodeURIComponent(it.id)}`, body);
          results.push({ type: 'task', id: it.id, ok: true });
          applied++;
        } catch (e) {
          results.push({ type: 'task', id: it.id, ok: false, error: e.message });
          failed++;
        }
      }
      return ok({
        status: 'completed',
        applied,
        failed,
        results,
        note: 'Milestones were not written (read-only via API). Their dates derive from these tasks and are recalculated by Accelo.',
      });
    }
  );

  server.tool(
    'progress_task',
    'Run a task PROGRESSION to transition its status. WRITE OPERATION: requires confirm:true. In Accelo, task status is changed via progressions, not direct writes. Use list_task_progressions to find the progression_id that leads to the status you want, then run it here. Tries the standard and /auto endpoint shapes automatically.',
    {
      task_id: z.string().describe('The task ID to progress'),
      progression_id: z.string().describe('The progression ID to run (from list_task_progressions)'),
      confirm: z.boolean().optional().describe('Must be true to run. Omit/false to preview only.'),
    },
    async ({ task_id, progression_id, confirm }) => {
      const token = await getValidAcceloToken(subject);
      const current = await getTask(token, task_id);
      if (!current) return ok({ status: 'error', message: `Task ${task_id} not found.` });
      if (confirm !== true) {
        return needsConfirmation(`RUN progression ${progression_id} on task ${task_id} ("${current.title}")`, {
          task: `${task_id} ("${current.title}")`,
          current_status: statusLabel(current.task_status),
          progression_id,
        });
      }
      const result = await runProgression(token, task_id, progression_id);
      const after = await getTask(token, task_id);
      return ok({ status: 'progressed', via: result.path, task: after ? decorateTask(after) : null });
    }
  );

  server.tool(
    'cancel_task',
    'Cancel an Accelo task by running the cancel progression (progression 14 -> status 6 Cancelled). WRITE OPERATION: requires confirm:true. Accelo does not support deleting tasks; cancelling is a reversible status transition visible in the GUI. Optionally prepends "[CANCELLED] " to the title (via a separate update) so it is obvious in the GUI. First call (no confirm) previews; call again with confirm:true to apply.',
    {
      id: z.string().describe('The task ID to cancel'),
      mark_title: z.boolean().optional().describe('If true, prepend "[CANCELLED] " to the task title. Default false.'),
      confirm: z.boolean().optional().describe('Must be true to apply. Omit/false to preview only.'),
    },
    async ({ id, mark_title, confirm }) => {
      const token = await getValidAcceloToken(subject);
      const current = await getTask(token, id);
      if (!current) return ok({ status: 'error', message: `Task ${id} not found.` });
      const alreadyMarked = String(current.title || '').startsWith('[CANCELLED] ');
      const newTitle = mark_title && !alreadyMarked ? `[CANCELLED] ${current.title}` : undefined;
      if (confirm !== true) {
        return needsConfirmation(`CANCEL task ${id} ("${current.title}")`, {
          task: `${id} ("${current.title}")`,
          action: `Run progression ${CANCEL_PROGRESSION_ID} -> status ${CANCELLED_STATUS} (Cancelled)`,
          current_status: statusLabel(current.task_status),
          title_change: newTitle ? { from: current.title, to: newTitle } : undefined,
        });
      }
      if (newTitle) await acceloPut(token, `/tasks/${encodeURIComponent(id)}`, { title: newTitle });
      const result = await runProgression(token, id, CANCEL_PROGRESSION_ID);
      const after = await getTask(token, id);
      return ok({ status: 'cancelled', via: result.path, task: after ? decorateTask(after) : null });
    }
  );
}
