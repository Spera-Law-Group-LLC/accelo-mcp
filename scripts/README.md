# Accelo Quote Export + Knowledge Base Runbook

Durable, repeatable pipeline to export every **accepted** and **converted** quote
PDF from Accelo and turn them into a single consolidated knowledge base for a
LibreChat agent (so an AI can reference past winning quotes when drafting new
ones).

> These scripts are reusable. The actual exported PDFs, extracted text, and KB
> artifacts are **not** committed (they live in the gitignored `data/` dir and
> contain client information).

## Status IDs

| Accelo quote status | ID |
| --- | --- |
| accepted | 3 |
| converted | 5 |

Filter both with the raw Accelo filter `status(3,5)`. (Note: `standing(...)`
expects text labels, not IDs, and silently matches nothing.)

## Accelo data chain (validated)

```
/quotes?_filters=status(3,5)            -> accepted + converted quotes
quote.against_id (against_type==prospect) is the parent DEAL id
/prospects/{id}?_fields=_ALL            -> deal title + date_actioned (won date)
/quotes/{id}/collections?_fields=_ALL   -> collections[].id
/resources?_filters=collection_id(cid)  -> the application/pdf resource id
/resources/{rid}/download               -> the PDF bytes
```

The MCP `get_deal` tool wraps `/prospects/{id}?_fields=_ALL` for ongoing agent
use (resolve a quote's `against_id` -> parent deal).

## Filename format

```
YYYY-MM-DD - {QUOTE ID} - {Parent Deal Title}.pdf
```

- Date = parent deal `date_actioned` (deal-won date), fallback `date_modified`,
  formatted `America/Chicago`.
- Title = parent **deal** title (not the quote's own title).

## Procedure

All steps run inside the `accelo-mcp` container, which already has the Accelo
config + stored OAuth token (reused read-only; no secrets in these scripts).

```bash
# 0. Copy the two scripts into the container's data dir (bind-mounted at
#    /opt/accelo-mcp/data on the host):
cp scripts/export_accepted_converted_quote_pdfs.mjs /opt/accelo-mcp/data/
cp scripts/build_quote_kb.py                         /opt/accelo-mcp/data/

# 1. Export PDFs (run detached for a few hundred quotes; ~10 min):
docker exec -d accelo-mcp sh -c \
  'node /app/data/export_accepted_converted_quote_pdfs.mjs > /app/data/export.log 2>&1'
# watch progress:
tail -f /opt/accelo-mcp/data/export.log     # ends with: DONE total=.. pdf=.. nopdf=.. err=..

# 2. Extract text from each PDF:
docker exec accelo-mcp bash -c \
  'apt-get update -qq && apt-get install -y -qq poppler-utils && \
   cd /app/data/export && mkdir -p ../export_txt && \
   for f in *.pdf; do pdftotext -layout "$f" "../export_txt/${f%.pdf}.txt"; done'

# 3. Build the consolidated KB (quotes_kb.md + quotes_kb.jsonl):
docker exec accelo-mcp python3 /app/data/build_quote_kb.py
```

## Outputs (on the host, gitignored)

| Path | What |
| --- | --- |
| `/opt/accelo-mcp/data/export/*.pdf` | one PDF per quote (the deliverable for Google Drive) |
| `/opt/accelo-mcp/data/export/manifest.json` | every quote incl. no-PDF cases |
| `/opt/accelo-mcp/data/quotes_kb.md` | single-file KB for LibreChat file-search (upload this) |
| `/opt/accelo-mcp/data/quotes_kb.jsonl` | structured alternative (1 record/quote) |

## Delivering the results

**PDFs -> Google Drive** (manual; bundle then drag-drop):

```bash
# on Hetzner: bundle (zip/unzip may be absent; tar is always present)
tar -czf /opt/accelo-mcp/data/accelo_quotes_export.tar.gz \
  -C /opt/accelo-mcp/data/export --exclude=manifest.json .

# on your Mac: pull, verify, expand, then drag into the Drive folder
scp root@ai.speralaw.com:/opt/accelo-mcp/data/accelo_quotes_export.tar.gz ~/Downloads/
mkdir -p ~/Downloads/accelo_quotes
tar -xzf ~/Downloads/accelo_quotes_export.tar.gz -C ~/Downloads/accelo_quotes
```

**KB -> LibreChat agent**: download `quotes_kb.md` and upload it to the agent's
File Search.

```bash
scp root@ai.speralaw.com:/opt/accelo-mcp/data/quotes_kb.md ~/Downloads/
```

## Notes / gotchas

- ~Some converted quotes have **no PDF attached** in Accelo (logged as
  `NO_PDF` in the manifest) - nothing to download for those.
- Largest single PDF observed ~340 KB; full set ~45 MB across ~377 files. The
  consolidated `quotes_kb.md` is ~3.6 MB - under LibreChat's default 20 MB
  file-search per-file limit and avoids the file-count limit entirely.
- Rate limit: Accelo allows 5000 req/hour; auth requests are not counted.
