// One-time / repeatable export of accepted(3)+converted(5) quote PDFs from Accelo.
//
// Output: one PDF per quote in ./data/export, named
//   "YYYY-MM-DD - {QUOTE ID} - {Parent Deal Title}.pdf"
// where the date is the parent deal's date_actioned (deal-won date), falling
// back to the quote's date_modified, formatted in America/Chicago. Also writes
// ./data/export/manifest.json describing every quote (including ones with no PDF).
//
// HOW TO RUN (from the accelo-mcp container, which already has the OAuth token
// store and Accelo config):
//   docker exec accelo-mcp node /app/data/export_accepted_converted_quote_pdfs.mjs
// (or run it detached with logging for long runs:
//   docker exec -d accelo-mcp sh -c 'node /app/data/export_accepted_converted_quote_pdfs.mjs > /app/data/export.log 2>&1')
//
// AUTH: reuses the most-recent Accelo token from the container's SQLite token
// store (src/db.js -> accelo_tokens), refreshing it if near expiry. No secrets
// are embedded in this file.
//
// ACCELO DATA CHAIN (validated):
//   /quotes?_filters=status(3,5)            -> accepted + converted quotes
//   quote.against_id (when against_type=="prospect") is the parent DEAL id
//   /prospects/{id}?_fields=_ALL            -> deal title + date_actioned
//   /quotes/{id}/collections?_fields=_ALL   -> collections[].id
//   /resources?_filters=collection_id(cid)  -> the application/pdf resource id
//   /resources/{rid}/download               -> the PDF bytes
//
// Accelo rate limit is 5000 requests/hour; a few hundred quotes x ~3 calls each
// is well within budget.

import { config } from '/app/src/config.js';
import db from '/app/src/db.js';
import fs from 'node:fs';

const OUT = '/app/data/export';
fs.mkdirSync(OUT, { recursive: true });

const row = db.prepare('SELECT * FROM accelo_tokens ORDER BY created_at DESC LIMIT 1').get();
if (!row) { console.log('NO_TOKEN'); process.exit(1); }
let token = row.access_token;

async function ensureToken() {
  if (Date.now() > row.expires_at - 60000) {
    const b = 'Basic ' + Buffer.from(config.acceloClientId + ':' + config.acceloClientSecret).toString('base64');
    const r = await fetch(config.acceloOAuthUrl + '/token', {
      method: 'POST',
      headers: { Authorization: b, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token || '' }),
    });
    const j = await r.json();
    if (!j.access_token) throw new Error('refresh failed');
    token = j.access_token;
  }
}

async function api(p) {
  const r = await fetch(config.acceloBaseUrl + p, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  if (!r.ok) throw new Error('API ' + p + ' ' + r.status + ' ' + t.slice(0, 180));
  return j.response;
}

async function dl(rid) {
  const r = await fetch(config.acceloBaseUrl + '/resources/' + rid + '/download', { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('dl ' + rid + ' ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// Strip characters that are unsafe in filenames; collapse whitespace; cap length.
function san(s) {
  return (s || '').replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// Unix epoch seconds -> YYYY-MM-DD in America/Chicago.
function ymd(e) {
  const d = new Date(Number(e) * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

await ensureToken();

// Page through accepted + converted quotes (status IDs 3 and 5).
let quotes = [], page = 0;
while (true) {
  const f = '/quotes?_filters=status(3,5)&_fields=id,title,against_type,against_id,standing,date_created,date_modified&_limit=100&_page=' + page;
  const batch = await api(f);
  if (!batch || batch.length === 0) break;
  quotes = quotes.concat(batch); page++;
  if (batch.length < 100) break;
}
console.log('TOTAL_QUOTES', quotes.length);

const manifest = [], dealCache = {};
for (const q of quotes) {
  try {
    let dealTitle = q.title, dateEpoch = q.date_modified;
    // Resolve the parent deal for its title + actioned (won) date.
    if (q.against_type === 'prospect' && q.against_id) {
      if (!dealCache[q.against_id]) dealCache[q.against_id] = await api('/prospects/' + q.against_id + '?_fields=_ALL');
      const d = dealCache[q.against_id];
      if (d && d.title) dealTitle = d.title;
      if (d && d.date_actioned) dateEpoch = d.date_actioned;
    }
    const base = ymd(dateEpoch) + ' - ' + q.id + ' - ' + san(dealTitle);

    // Find the quote's PDF via its collection -> resources.
    const col = await api('/quotes/' + q.id + '/collections?_fields=_ALL');
    const cols = (col && col.collections) || [];
    let pdf = null;
    for (const c of cols) {
      const res = await api('/resources?_filters=collection_id(' + c.id + ')&_fields=_ALL');
      const arr = Array.isArray(res) ? res : [];
      const cand = arr.filter(x => x.mimetype === 'application/pdf' || /\.pdf$/i.test(x.title || ''));
      if (cand.length) { cand.sort((a, b) => Number(b.date_created || 0) - Number(a.date_created || 0)); pdf = cand[0]; break; }
    }

    if (!pdf) {
      manifest.push({ quote_id: q.id, status: q.standing, deal_id: q.against_id, deal_title: dealTitle, date: ymd(dateEpoch), filename: base + '.pdf', pdf: false, note: 'NO_PDF' });
      console.log('NOPDF', q.id);
      continue;
    }
    const buf = await dl(pdf.id);
    const fname = base + '.pdf';
    fs.writeFileSync(OUT + '/' + fname, buf);
    manifest.push({ quote_id: q.id, status: q.standing, deal_id: q.against_id, deal_title: dealTitle, date: ymd(dateEpoch), resource_id: pdf.id, bytes: buf.length, filename: fname, pdf: true });
    console.log('OK', q.id, buf.length, fname);
  } catch (e) {
    manifest.push({ quote_id: q.id, error: String(e.message || e) });
    console.log('ERR', q.id, String(e.message || e));
  }
}

fs.writeFileSync(OUT + '/manifest.json', JSON.stringify(manifest, null, 2));
console.log('DONE total=' + manifest.length + ' pdf=' + manifest.filter(m => m.pdf).length + ' nopdf=' + manifest.filter(m => m.pdf === false).length + ' err=' + manifest.filter(m => m.error).length);
process.exit(0);
