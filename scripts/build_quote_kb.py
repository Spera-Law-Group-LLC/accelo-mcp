#!/usr/bin/env python3
"""Build a consolidated knowledge base from exported quote PDFs.

Reads the manifest + extracted plain text produced from the quote PDFs and
writes two single-file artifacts suitable for LibreChat file-search (semantic
search):

  data/quotes_kb.md     - one Markdown section per quote (recommended upload)
  data/quotes_kb.jsonl  - one JSON record per quote (structured alternative)

WHY: feeding ~377 individual PDF binaries (~45 MB) into an agent hits both the
per-file size cap and the file-count cap, and retrieves poorly. Pre-extracting
the text and consolidating it yields a ~3.6 MB single file that fits well under
LibreChat's default 20 MB file-search limit and searches faster/better.

PREREQUISITES (run inside the accelo-mcp container):
  1. Run export_accepted_converted_quote_pdfs.mjs first (creates data/export/*.pdf
     and data/export/manifest.json).
  2. Extract text from each PDF with poppler-utils, e.g.:
       apt-get update -qq && apt-get install -y -qq poppler-utils
       cd /app/data/export && mkdir -p ../export_txt
       for f in *.pdf; do pdftotext -layout "$f" "../export_txt/${f%.pdf}.txt"; done
  3. Run this script:
       docker exec accelo-mcp python3 /app/data/build_quote_kb.py
"""
import json
import os

base = '/app/data'
exp = base + '/export'
txt = base + '/export_txt'

man = json.load(open(exp + '/manifest.json'))
rows = [m for m in man if m.get('pdf')]

out = open(base + '/quotes_kb.jsonl', 'w')
md = open(base + '/quotes_kb.md', 'w')
n = 0
for m in rows:
    tf = txt + '/' + m['filename'][:-4] + '.txt'
    if not os.path.exists(tf):
        continue
    body = open(tf, encoding='utf-8', errors='replace').read().strip()
    rec = {
        'quote_id': m['quote_id'],
        'status': m['status'],
        'date': m['date'],
        'deal_id': m.get('deal_id'),
        'deal_title': m.get('deal_title'),
        'text': body,
    }
    out.write(json.dumps(rec, ensure_ascii=False) + '\n')
    md.write('\n\n# Quote ' + str(m['quote_id']) + ' - ' + str(m.get('deal_title')) + '\n')
    md.write('Status: ' + str(m['status']) + ' | Date: ' + str(m['date']) + ' | Deal ID: ' + str(m.get('deal_id')) + '\n\n')
    md.write(body + '\n\n---\n')
    n += 1
out.close()
md.close()
print('records', n)
