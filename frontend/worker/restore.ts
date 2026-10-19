// Finds deleted orders in `order.deleted` events and restores them.
// Pure logic over a minimal Swell client so it can be tested without the platform.

export type SwellClient = {
  get(path: string, query?: Record<string, unknown>): Promise<unknown>;
  post(path: string, data: Record<string, unknown>): Promise<unknown>;
};

export class RestoreError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type List<T> = { count?: number; results?: T[] };

export type DeletedOrderEvent = {
  id: string;
  type?: string;
  date_created?: string;
  data?: Record<string, unknown> & { id?: string };
};

export type DeletedOrderRow = {
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

export type SearchOptions = { dateFrom: string; dateTo: string; notCanceled: boolean; page: number };

export type SearchPage = {
  page: number; pages: number; count: number; results: DeletedOrderRow[]; order_ids: string[]; done: boolean;
};

export type RestoreResult = {
  event_id: string;
  order_id: string | null;
  number: string | null;
  status: 'restored' | 'skipped' | 'failed';
  error?: string;
};

// Events read per search request
export const EVENTS_PAGE_SIZE = 1000;
// Ids per `$in` lookup, keeps query strings short
export const LOOKUP_BATCH_SIZE = 100;
// Orders per restore request
export const RESTORE_BATCH_SIZE = 10;

const OBJECT_ID = /^[0-9a-f]{24}$/;

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID.test(value);
}

export function parseDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || Number.isNaN(Date.parse(value))) {
    throw new RestoreError(`Invalid ${name}`);
  }
  return new Date(value).toISOString();
}

export function parseSearchOptions(body: Record<string, unknown>): SearchOptions {
  const dateFrom = parseDate(body.date_from, 'start date');
  const dateTo = parseDate(body.date_to, 'end date');
  if (dateFrom >= dateTo) throw new RestoreError('The end date must be after the start date');
  const page = body.page ?? 1;
  if (!Number.isInteger(page) || (page as number) < 1) throw new RestoreError('Invalid page');
  return { dateFrom, dateTo, notCanceled: body.not_canceled === true, page: page as number };
}

export function parseEventIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) throw new RestoreError('Select at least one order');
  if (value.length > RESTORE_BATCH_SIZE) throw new RestoreError(`Restore at most ${RESTORE_BATCH_SIZE} orders per request`);
  if (!value.every(isObjectId)) throw new RestoreError('Invalid event id');
  return [...new Set(value)];
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

const str = (value: unknown) => (typeof value === 'string' && value ? value : null);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// Ids from `ids` that belong to existing (not deleted) orders
export async function existingOrderIds(swell: SwellClient, ids: string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const batch of chunk(ids, LOOKUP_BATCH_SIZE)) {
    const result = await swell.get('/orders', {
      where: { id: { $in: batch } }, fields: 'id', limit: batch.length,
    }) as List<{ id: string }>;
    for (const order of result?.results || []) existing.add(order.id);
  }
  return existing;
}

type Address = { name?: unknown; first_name?: unknown; last_name?: unknown };

// Full name of an order address: its name, or first and last name
function fullName(address: unknown): string | null {
  if (!address || typeof address !== 'object') return null;
  const { name, first_name: firstName, last_name: lastName } = address as Address;
  return str(typeof name === 'string' ? name.trim() : null)
    || str([firstName, lastName].map((part) => (typeof part === 'string' ? part.trim() : '')).filter(Boolean).join(' '));
}

// One page of `order.deleted` events in the period, newest first, reduced to orders that
// don't exist now and have an account. Only the latest event of each order is kept; the caller
// dedupes across pages.
export async function searchDeletedOrders(swell: SwellClient, options: SearchOptions): Promise<SearchPage> {
  const events = await swell.get('/events', {
    where: {
      type: 'order.deleted',
      date_created: { $gte: options.dateFrom, $lt: options.dateTo },
    },
    fields: 'id,date_created,data.id,data.number,data.date_created,data.grand_total,data.currency,data.account_id,data.canceled,' +
      'data.shipping.name,data.shipping.first_name,data.shipping.last_name,data.billing.name,data.billing.first_name,data.billing.last_name',
    sort: 'date_created desc',
    limit: EVENTS_PAGE_SIZE,
    page: options.page,
  }) as List<DeletedOrderEvent>;
  const count = events?.count || 0;
  const pages = Math.max(1, Math.ceil(count / EVENTS_PAGE_SIZE));

  const latest = new Map<string, DeletedOrderEvent>();
  for (const event of events?.results || []) {
    const orderId = event.data?.id;
    if (isObjectId(orderId) && !latest.has(orderId)) latest.set(orderId, event);
  }

  // filters apply to the latest deletion only: an older one is never listed instead
  const candidates = [...latest.values()].filter((event) => str(event.data!.account_id)
    && !(options.notCanceled && event.data!.canceled === true));
  const existing = await existingOrderIds(swell, candidates.map((event) => event.data!.id!));
  const deleted = candidates.filter((event) => !existing.has(event.data!.id!));

  const results = deleted.map((event): DeletedOrderRow => {
    const data = event.data!;
    return {
      event_id: event.id,
      order_id: data.id!,
      number: str(data.number),
      date_created: str(data.date_created),
      date_deleted: str(event.date_created),
      grand_total: num(data.grand_total),
      currency: str(data.currency),
      account_id: str(data.account_id)!,
      name: fullName(data.shipping) || fullName(data.billing),
      canceled: data.canceled === true,
    };
  });

  return { page: options.page, pages, count, results, order_ids: [...latest.keys()], done: options.page >= pages };
}

export async function getDeletedOrderEvent(swell: SwellClient, eventId: string): Promise<DeletedOrderEvent> {
  const event = await swell.get(`/events/${eventId}`) as DeletedOrderEvent | null;
  if (!event?.id || event.type !== 'order.deleted') throw new RestoreError('Deleted order event not found', 404);
  return event;
}

// Restores each order from its `order.deleted` event. Orders that exist again are skipped;
// a failure on one order doesn't stop the others.
export async function restoreOrders(swell: SwellClient, eventIds: string[]): Promise<RestoreResult[]> {
  const results: RestoreResult[] = [];
  for (const eventId of eventIds) {
    let orderId: string | null = null;
    let number: string | null = null;
    try {
      const event = await getDeletedOrderEvent(swell, eventId);
      const data = event.data;
      if (!data || !isObjectId(data.id)) throw new RestoreError('The event has no order data');
      orderId = data.id;
      number = str(data.number);
      if ((await existingOrderIds(swell, [orderId])).has(orderId)) {
        results.push({ event_id: eventId, order_id: orderId, number, status: 'skipped', error: 'The order already exists' });
        continue;
      }
      const restored = await swell.post('/orders', { ...data, $restore: true }) as { id?: string; errors?: unknown } | null;
      if (!restored?.id || restored.errors) {
        throw new RestoreError(restored?.errors ? JSON.stringify(restored.errors) : 'The order was not restored');
      }
      results.push({ event_id: eventId, order_id: orderId, number, status: 'restored' });
    } catch (err) {
      results.push({
        event_id: eventId, order_id: orderId, number, status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
