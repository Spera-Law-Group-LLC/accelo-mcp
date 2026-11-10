const UPSTREAM_PAGE_SIZE = 100;

// Fetch the caller's window plus one lookahead row using Accelo's capped pages.
export async function fetchWindow(fetchPage, limit, page = 0) {
  const start = page * limit;
  const offset = start % UPSTREAM_PAGE_SIZE;
  const needed = offset + limit + 1;
  let upstreamPage = Math.floor(start / UPSTREAM_PAGE_SIZE);
  const rows = [];

  while (rows.length < needed) {
    const batch = await fetchPage(upstreamPage, UPSTREAM_PAGE_SIZE);
    rows.push(...batch);
    if (batch.length < UPSTREAM_PAGE_SIZE) break;
    upstreamPage += 1;
  }

  return rows.slice(offset, needed);
}
