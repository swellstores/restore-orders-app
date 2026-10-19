// Merging and sorting of search results. Pages come newest first, so the first page that has an
// order holds its latest deletion in the period; later pages must not list an older deletion of
// that order, even when the latest one was filtered out (canceled, no account).

export type SearchPageResult<Row extends { order_id: string }> = { results: Row[]; order_ids: string[] };

export function mergeSearchPage<Row extends { order_id: string }>(
  found: Map<string, Row>, seen: Set<string>, page: SearchPageResult<Row>,
) {
  for (const row of page.results) {
    if (!seen.has(row.order_id)) found.set(row.order_id, row);
  }
  for (const orderId of page.order_ids) seen.add(orderId);
}

type SortableRow = { date_created: string | null; date_deleted: string | null };

// Newest first; rows without the date go last, ties keep the latest deletion first
export function sortRows<Row extends SortableRow>(rows: Row[], sortBy: 'date_deleted' | 'date_created'): Row[] {
  const time = (value: string | null) => (value ? Date.parse(value) : -Infinity);
  return [...rows].sort((a, b) => (time(b[sortBy]) - time(a[sortBy]))
    || (time(b.date_deleted) - time(a.date_deleted)));
}
