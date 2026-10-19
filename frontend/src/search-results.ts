// Merging of search pages. Pages come newest first, so the first page that has an order holds
// its latest deletion in the period; later pages must not list an older deletion of that order,
// even when the latest one was filtered out (canceled, no account).

export type SearchPageResult<Row extends { order_id: string }> = { results: Row[]; order_ids: string[] };

export function mergeSearchPage<Row extends { order_id: string }>(
  found: Map<string, Row>, seen: Set<string>, page: SearchPageResult<Row>,
) {
  for (const row of page.results) {
    if (!seen.has(row.order_id)) found.set(row.order_id, row);
  }
  for (const orderId of page.order_ids) seen.add(orderId);
}
