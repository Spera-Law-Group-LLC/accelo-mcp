import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { parseArgs } from 'node:util';
import { redirectUriOrigin } from '../src/redirect-uri.js';

dotenv.config();

let options;
try {
  options = parseArgs({
    options: {
      json: { type: 'boolean', default: false },
      'stale-days': { type: 'string', default: '90' },
      prune: { type: 'boolean', default: false },
      confirm: { type: 'boolean', default: false },
    },
  }).values;
  if (!/^[1-9]\d*$/.test(options['stale-days']) ||
      !Number.isSafeInteger(Number(options['stale-days'])) ||
      !Number.isSafeInteger(Number(options['stale-days']) * 86400000)) {
    throw new Error('invalid stale days');
  }
  if (options.confirm && !options.prune) throw new Error('confirm requires prune');
} catch {
  console.error('Usage: node scripts/registry-report.mjs [--json] [--stale-days N] [--prune [--confirm]] (N must be a positive integer)');
  process.exit(1);
}

function readReport(db, now, cutoff, eligibleIds) {
  const rows = db.prepare(`
    SELECT c.client_id, c.redirect_uris, c.scope, c.created_at, c.last_used_at,
      (SELECT COUNT(*) FROM access_tokens a
        WHERE a.client_id = c.client_id AND a.expires_at >= ?) AS access,
      (SELECT COUNT(*) FROM refresh_tokens r
        WHERE r.client_id = c.client_id AND (r.expires_at IS NULL OR r.expires_at >= ?)) AS refresh,
      (SELECT COUNT(*) FROM (
        SELECT subject FROM access_tokens WHERE client_id = c.client_id
        UNION
        SELECT subject FROM refresh_tokens WHERE client_id = c.client_id
      )) AS subjects
    FROM clients c
    ORDER BY c.last_used_at IS NULL, c.last_used_at DESC, c.client_id
  `).all(now, now).filter((row) => !eligibleIds || eligibleIds.has(row.client_id));
  const summary = { total: rows.length, LIVE: 0, STALE: 0, INERT: 0, never_observed: 0 };
  const clients = rows.map((row) => {
    let redirects;
    try {
      redirects = JSON.parse(row.redirect_uris);
    } catch {
      redirects = [];
    }
    if (!Array.isArray(redirects)) redirects = [];
    const origins = [...new Set(redirects.map(redirectUriOrigin).filter(Boolean))];
    const flags = redirects.length === 0 ? 'INERT'
      : row.refresh === 0 && (row.last_used_at === null || row.last_used_at < cutoff) ? 'STALE' : 'LIVE';
    summary[flags]++;
    if (row.last_used_at === null) summary.never_observed++;
    return {
      client_id: row.client_id.slice(0, 8),
      redirect_origins: origins.length ? origins.join(', ') : '(none)',
      scope: row.scope === 'read_only' ? 'read_only' : 'full',
      created_at: new Date(row.created_at).toISOString(),
      last_used_at: row.last_used_at === null ? 'never observed' : new Date(row.last_used_at).toISOString(),
      access: row.access,
      refresh: row.refresh,
      subjects: row.subjects,
      flags,
    };
  });
  return { clients, summary };
}

function printSummary(summary) {
  console.log(`Total: ${summary.total} | LIVE: ${summary.LIVE} | STALE: ${summary.STALE} | INERT: ${summary.INERT} | Never observed: ${summary.never_observed}`);
}

let db;
try {
  const filename = process.env.TOKEN_DB_PATH || './data/tokens.db';
  db = new Database(filename, {
    readonly: true,
    fileMustExist: true,
  });
  const now = Date.now();
  const cutoff = now - Number(options['stale-days']) * 86400000;
  const eligibleClients = (connection) => connection.prepare(`
    SELECT c.client_id FROM clients c
    WHERE NOT EXISTS (SELECT 1 FROM access_tokens WHERE client_id = c.client_id)
      AND NOT EXISTS (SELECT 1 FROM refresh_tokens WHERE client_id = c.client_id)
      AND c.last_used_at IS NULL
      AND c.created_at < ?
  `).all(now - 86400000).map((row) => row.client_id);
  let report;
  if (options.prune && options.confirm) {
    const writer = new Database(filename, { fileMustExist: true });
    try {
      report = writer.transaction(() => {
        const ids = eligibleClients(writer);
        const preview = readReport(db, now, cutoff, new Set(ids));
        const remove = writer.prepare('DELETE FROM clients WHERE client_id = ?');
        const deleted = ids.reduce((count, id) => count + remove.run(id).changes, 0);
        return { ...preview, deleted };
      }).immediate();
    } finally {
      writer.close();
    }
    report.remaining_summary = readReport(db, now, cutoff).summary;
  } else if (options.prune) {
    const ids = eligibleClients(db);
    report = { ...readReport(db, now, cutoff, new Set(ids)), would_delete: ids.length };
  } else {
    report = readReport(db, now, cutoff);
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.table(report.clients);
    printSummary(report.summary);
    if (options.prune && options.confirm) {
      console.log(`Deleted ${report.deleted} client rows.`);
      printSummary(report.remaining_summary);
    } else if (options.prune) {
      console.log(`Would delete ${report.would_delete} client rows. Dry run; no changes made.`);
    }
  }
} catch {
  console.error(options.prune && options.confirm
    ? 'Unable to prune the registry. Run inside the container or as deploy, after the server migration.'
    : 'Unable to read the registry. Run inside the container or as deploy, after the server migration.');
  process.exitCode = 1;
} finally {
  db?.close();
}
