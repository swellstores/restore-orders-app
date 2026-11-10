import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { mergeSearchPage, sortRows } from './search-results';
import { formatDate, formatMoney, localDate, startOfDay, startOfNextDay } from './format';

// Shapes returned by the Worker (worker/restore.ts)
type DeletedOrderRow = {
  event_id: string;
  order_id: string;
  number: string | null;
  date_created: string | null;
  date_deleted: string | null;
  grand_total: number | null;
  currency: string | null;
  account_id: string;
  name: string | null;
  canceled: boolean;
};
type SearchPage = {
  page: number; pages: number; count: number; results: DeletedOrderRow[]; order_ids: string[]; done: boolean;
};
type RestoreResult = {
  event_id: string;
  order_id: string | null;
  number: string | null;
  status: 'restored' | 'skipped' | 'failed';
  error?: string;
};

type Query = { dateFrom: string; dateTo: string; notCanceled: boolean };
type SearchStatus = 'idle' | 'searching' | 'done' | 'failed';
type EventView = { eventId: string; loading: boolean; data?: unknown; error?: string };
type SortBy = 'date_deleted' | 'date_created';
// The user's access to orders (worker/swell-server.ts): 'full' covers Manage and Full
type OrdersAccess = 'full' | 'view' | 'none';

const PAGE_SIZE = 10;
// must match RESTORE_BATCH_SIZE in worker/restore.ts; the Worker rejects larger batches
const RESTORE_BATCH_SIZE = 10;

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: 'date_deleted', label: 'Date deleted' },
  { value: 'date_created', label: 'Date created' },
];

class RequestError extends Error {
  details: unknown;
  constructor(message: string, details: unknown) {
    super(message);
    this.details = details;
  }
}

async function call<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let result: { error?: string; details?: unknown } = {};
  try { result = JSON.parse(text); } catch { /* not JSON */ }
  if (!response.ok) {
    throw new RequestError(
      result.error || `Request failed with status ${response.status}`,
      // a plain { error } is a message for the merchant; anything else is shown as details
      result.details ?? (result.error ? null : { status: response.status, response: text.slice(0, 2000) }),
    );
  }
  return result as T;
}

export default function DeletedOrders() {
  const today = new Date();
  const monthAgo = new Date(today);
  monthAgo.setDate(monthAgo.getDate() - 30);

  const [dateFrom, setDateFrom] = useState(localDate(monthAgo));
  const [dateTo, setDateTo] = useState(localDate(today));
  const [notCanceled, setNotCanceled] = useState(true);

  const [query, setQuery] = useState<Query | null>(null);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [progress, setProgress] = useState({ page: 0, pages: 0 });
  const [rows, setRows] = useState<DeletedOrderRow[]>([]);
  const [error, setError] = useState<{ message: string; details: unknown } | null>(null);

  const [sortBy, setSortBy] = useState<SortBy>('date_deleted');
  const [gridPage, setGridPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [eventView, setEventView] = useState<EventView | null>(null);

  const [access, setAccess] = useState<OrdersAccess | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState({ done: 0, total: 0 });
  const [restoreResults, setRestoreResults] = useState<RestoreResult[] | null>(null);

  // Users without access to orders get the error before they search; users who can only view orders can search but not restore
  useEffect(() => {
    call<{ orders: OrdersAccess }>('/app-api/admin/access')
      .then((result) => setAccess(result.orders))
      .catch((err) => {
        setAccess('none');
        setError({
          message: err instanceof Error ? err.message : 'Unable to check your access to orders',
          details: err instanceof RequestError ? err.details : String(err),
        });
      });
  }, []);

  // Orders are sent in batches from this page: closing it stops the batches that aren't sent yet
  useEffect(() => {
    if (!restoring) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [restoring]);

  // Reads all pages of deleted events for the query; an order deleted more than once is decided by its latest event.
  async function search(next: Query) {
    setQuery(next);
    setStatus('searching');
    setError(null);
    setProgress({ page: 0, pages: 0 });
    const found = new Map<string, DeletedOrderRow>();
    const seen = new Set<string>();
    try {
      for (let page = 1; ; page++) {
        const result = await call<SearchPage>('/app-api/admin/search', {
          date_from: startOfDay(next.dateFrom),
          date_to: startOfNextDay(next.dateTo),
          not_canceled: next.notCanceled,
          page,
        });
        mergeSearchPage(found, seen, result);
        setProgress({ page: result.page, pages: result.pages });
        if (result.done) break;
      }
      const list = [...found.values()];
      setRows(list);
      setSelected((current) => new Set(list.filter((row) => current.has(row.event_id)).map((row) => row.event_id)));
      setGridPage((current) => Math.min(current, Math.max(1, Math.ceil(list.length / PAGE_SIZE))));
      setStatus('done');
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Unable to search deleted orders',
        details: err instanceof RequestError ? err.details : String(err),
      });
      setStatus('failed');
    }
  }

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    setRestoreResults(null);
    setEventView(null);
    setSelected(new Set());
    setConfirming(false);
    setGridPage(1);
    void search({ dateFrom, dateTo, notCanceled });
  };

  async function showEvent(eventId: string) {
    if (eventView?.eventId === eventId) { setEventView(null); return; }
    setEventView({ eventId, loading: true });
    try {
      const data = await call<unknown>(`/app-api/admin/event?id=${encodeURIComponent(eventId)}`);
      setEventView((current) => (current?.eventId === eventId ? { eventId, loading: false, data } : current));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load the event';
      setEventView((current) => (current?.eventId === eventId ? { eventId, loading: false, error: message } : current));
    }
  }

  async function restore() {
    const eventIds = rows.filter((row) => selected.has(row.event_id)).map((row) => row.event_id);
    if (!eventIds.length || !query) return;
    setConfirming(false);
    setRestoring(true);
    setRestoreProgress({ done: 0, total: eventIds.length });
    setRestoreResults(null);
    const results: RestoreResult[] = [];
    for (let i = 0; i < eventIds.length; i += RESTORE_BATCH_SIZE) {
      const batch = eventIds.slice(i, i + RESTORE_BATCH_SIZE);
      try {
        results.push(...(await call<{ results: RestoreResult[] }>('/app-api/admin/restore', { event_ids: batch })).results);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to restore orders';
        for (const eventId of batch) {
          const row = rows.find((item) => item.event_id === eventId);
          results.push({ event_id: eventId, order_id: row?.order_id ?? null, number: row?.number ?? null, status: 'failed', error: message });
        }
      }
      setRestoreProgress({ done: results.length, total: eventIds.length });
    }
    setRestoreResults(results);
    setSelected(new Set());
    setEventView(null);
    setRestoring(false);
    await search(query);
  }

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const sortedRows = useMemo(() => sortRows(rows, sortBy), [rows, sortBy]);
  const pageRows = sortedRows.slice((gridPage - 1) * PAGE_SIZE, gridPage * PAGE_SIZE);
  const pageSelected = pageRows.length > 0 && pageRows.every((row) => selected.has(row.event_id));
  const searching = status === 'searching';
  const busy = searching || restoring || confirming;
  const canRestore = access === 'full';

  const toggle = (eventId: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(eventId)) next.delete(eventId); else next.add(eventId);
    return next;
  });
  const togglePage = () => setSelected((current) => {
    const next = new Set(current);
    for (const row of pageRows) {
      if (pageSelected) next.delete(row.event_id); else next.add(row.event_id);
    }
    return next;
  });

  const restored = restoreResults?.filter((result) => result.status === 'restored').length ?? 0;
  const notRestored = restoreResults?.filter((result) => result.status !== 'restored') ?? [];

  return <section className="restore">
    <form className="search" onSubmit={onSearch}>
      <label>
        Date start
        <input type="date" value={dateFrom} max={dateTo || undefined} required onChange={(event) => setDateFrom(event.target.value)} />
      </label>
      <label>
        Date end
        <input type="date" value={dateTo} min={dateFrom || undefined} required onChange={(event) => setDateTo(event.target.value)} />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={notCanceled} onChange={(event) => setNotCanceled(event.target.checked)} />
        Only not canceled
      </label>
      <button type="submit" className="primary" disabled={busy || access === null || access === 'none' || !dateFrom || !dateTo || dateFrom > dateTo}>Search</button>
    </form>

    {access === 'view' && <div className="notice notice-warning" role="status">
      <p>You can only view orders in this store, so you can search deleted orders but not restore them. Ask the store owner to give you Manage or Full access to orders.</p>
    </div>}

    {restoring && <p role="status">
      Restoring {restoreProgress.done} of {restoreProgress.total}… Keep this page open until it finishes.
    </p>}

    {searching && <p role="status">
      Searching{progress.pages > 1 ? ` · events page ${progress.page} of ${progress.pages}` : '…'}
    </p>}

    {restoreResults && <div className={`notice ${notRestored.length ? 'notice-warning' : 'notice-success'}`} role="status">
      <p>Restored {restored} {restored === 1 ? 'order' : 'orders'}.{notRestored.length > 0 && ` ${notRestored.length} not restored:`}</p>
      {notRestored.length > 0 && <ul>
        {notRestored.map((result) => <li key={result.event_id}>
          Order {result.number || result.order_id || result.event_id}: {result.error || result.status}
        </li>)}
      </ul>}
    </div>}

    {error && <div className="error" role="alert">
      <p>{error.message}</p>
      {error.details != null && <details open>
        <summary>Error details</summary>
        <pre>{JSON.stringify(error.details, null, 2)}</pre>
      </details>}
    </div>}

    {query && status !== 'failed' && (status === 'done' || rows.length > 0) && <>
      <div className="toolbar">
        <p>
          {rows.length} deleted {rows.length === 1 ? 'order' : 'orders'} found
          {selected.size > 0 && <> · {selected.size} selected</>}
        </p>
        <div className="toolbar-actions">
          {rows.length > 1 && <label className="sort">
            Sort by
            <select value={sortBy} onChange={(event) => { setSortBy(event.target.value as SortBy); setGridPage(1); }}>
              {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>}
          {rows.length > 0 && selected.size < rows.length && <button type="button" onClick={() => setSelected(new Set(rows.map((row) => row.event_id)))} disabled={busy}>
            Select all {rows.length}
          </button>}
          {selected.size > 0 && <button type="button" onClick={() => setSelected(new Set())} disabled={busy}>Clear selection</button>}
          {canRestore && <button type="button" className="primary" onClick={() => setConfirming(true)} disabled={busy || selected.size === 0}>
            {restoring ? 'Restoring…' : `Restore${selected.size ? ` ${selected.size}` : ''}`}
          </button>}
        </div>
      </div>

      {confirming && <div className="notice notice-warning confirm" role="alertdialog" aria-label="Confirm restore">
        <p>
          Restore {selected.size} {selected.size === 1 ? 'order' : 'orders'}? Each order is created again with its original
          id, number and data. Order emails and webhooks aren't sent, but apps' functions for new orders run.
        </p>
        <div className="confirm-actions">
          <button type="button" className="primary" onClick={() => void restore()}>
            Restore {selected.size} {selected.size === 1 ? 'order' : 'orders'}
          </button>
          <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      </div>}

      {rows.length > 0 && <div className="grid-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th className="select">
                <input type="checkbox" aria-label="Select orders on this page" checked={pageSelected} onChange={togglePage} disabled={busy} />
              </th>
              <th>Order number</th>
              <th aria-sort={sortBy === 'date_created' ? 'descending' : undefined}>Date created{sortBy === 'date_created' && ' ↓'}</th>
              <th aria-sort={sortBy === 'date_deleted' ? 'descending' : undefined}>Date deleted{sortBy === 'date_deleted' && ' ↓'}</th>
              <th className="amount">Grand total</th>
              <th>Account ID</th>
              <th>Full name</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => <tr
              key={row.event_id}
              className={eventView?.eventId === row.event_id ? 'active' : undefined}
              onClick={() => void showEvent(row.event_id)}
            >
              <td className="select" onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  aria-label={`Select order ${row.number || row.order_id}`}
                  checked={selected.has(row.event_id)}
                  onChange={() => toggle(row.event_id)}
                  disabled={busy}
                />
              </td>
              <td>
                <button type="button" className="link" onClick={(event) => { event.stopPropagation(); void showEvent(row.event_id); }}>
                  {row.number || row.order_id}
                </button>
                {row.canceled && <span className="badge">Canceled</span>}
              </td>
              <td>{formatDate(row.date_created)}</td>
              <td>{formatDate(row.date_deleted)}</td>
              <td className="amount">{formatMoney(row.grand_total, row.currency)}</td>
              <td className="mono">{row.account_id}</td>
              <td>{row.name}</td>
            </tr>)}
          </tbody>
        </table>
      </div>}

      {pageCount > 1 && <nav className="pager" aria-label="Pages">
        <button type="button" onClick={() => setGridPage(1)} disabled={gridPage === 1}>«</button>
        <button type="button" onClick={() => setGridPage(gridPage - 1)} disabled={gridPage === 1}>Previous</button>
        <span>Page {gridPage} of {pageCount}</span>
        <button type="button" onClick={() => setGridPage(gridPage + 1)} disabled={gridPage === pageCount}>Next</button>
        <button type="button" onClick={() => setGridPage(pageCount)} disabled={gridPage === pageCount}>»</button>
      </nav>}

      {eventView && <div className="event">
        <div className="event-header">
          <h2>Event data</h2>
          <button type="button" onClick={() => setEventView(null)}>Close</button>
        </div>
        {eventView.loading && <p>Loading…</p>}
        {eventView.error && <p className="error" role="alert">{eventView.error}</p>}
        {eventView.data != null && <pre>{JSON.stringify(eventView.data, null, 2)}</pre>}
      </div>}
    </>}
  </section>;
}
