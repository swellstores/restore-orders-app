import {
  RestoreError, getDeletedOrderEvent, isObjectId, parseEventIds, parseSearchOptions, restoreOrders, searchDeletedOrders,
  type SwellClient,
} from './restore';

export function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

type BackendContext = { storeId: string; apiHost: string; accessToken: string };
export type OrdersAccess = 'full' | 'view' | 'none';
type StaffContext = BackendContext & { ordersAccess: OrdersAccess };

type StaffUser = {
  role?: { permissions?: Record<string, string> } | null;
  all_permissions?: boolean;
  permissions?: string[] | null;
};

// The user's access to orders, by the dashboard's rule: their role's Orders level (No access, View, Manage or Full),
// or without a role their permissions list. Neither means full access.
export function ordersAccess(user: StaffUser): OrdersAccess {
  const role = user.role?.permissions;
  if (role) {
    if (role.orders === 'restrict') return 'none';
    return role.orders === 'view' ? 'view' : 'full';
  }
  if (user.all_permissions || !user.permissions) return 'full';
  return user.permissions.includes('orders') ? 'full' : 'none';
}

const NO_ORDERS_ACCESS = "You don't have access to orders in this store. Ask the store owner to give you access to orders.";
const VIEW_ORDERS_ONLY = 'You can only view orders in this store, so you can\'t restore them. Ask the store owner to give you Manage or Full access to orders.';

// Validates the staff session against Swell, requires it to belong to the current store and reads the user's access
// to orders. A user without access to orders gets an error.
async function authorizeStaff(request: Request): Promise<StaffContext | Response> {
  const cookie = (request.headers.get('Cookie') || '').split(';')
    .map((part) => part.trim()).find((part) => part.startsWith('_swell_admin_session='));
  let sessionId;
  try { sessionId = cookie && decodeURIComponent(cookie.slice('_swell_admin_session='.length)); }
  catch { return json({ error: 'Invalid session' }, 401); }
  if (!sessionId) return json({ error: 'Open this app from the Swell dashboard to sign in.' }, 401);

  const storeId = request.headers.get('Swell-Store-Id');
  const adminUrl = request.headers.get('Swell-Admin-Url');
  const apiHost = request.headers.get('Swell-API-Host');
  const accessToken = request.headers.get('Swell-Access-Token');
  if (!storeId || !adminUrl || !apiHost || !accessToken) {
    return json({ error: 'Swell request context is unavailable' }, 503);
  }
  let user: StaffUser | null;
  try {
    const admin = (path: string) => fetch(new URL(path, adminUrl), { headers: { 'X-Session': sessionId }, redirect: 'manual' });
    const sessionResponse = await admin('/admin/api/session');
    const session = sessionResponse.ok ? await sessionResponse.json() as { user_id?: string; client_id?: string } : null;
    if (!session?.user_id || session.client_id !== storeId) {
      return json({ error: 'Unauthorized' }, 401);
    }
    // The dashboard's user record carries the role and permissions the user has in this store
    const userResponse = await admin('/admin/api/user');
    user = userResponse.ok ? await userResponse.json() as StaffUser | null : null;
  } catch (err) {
    const details = { step: 'validate admin session', exception: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    return json({ error: 'Unable to complete the platform request', details }, 502);
  }
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const access = ordersAccess(user);
  if (access === 'none') return json({ error: NO_ORDERS_ACCESS }, 403);
  return { storeId, apiHost, accessToken, ordersAccess: access };
}

// CSRF protection for cookie-authenticated mutations: same-origin JSON requests only.
function isSameOriginJson(request: Request) {
  const origin = request.headers.get('Origin');
  const contentType = request.headers.get('Content-Type') || '';
  return Boolean(origin) && origin === new URL(request.url).origin
    && contentType.startsWith('application/json');
}

// Upstream Backend API failure, with details that are safe to show to staff
class BackendError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.details = details;
  }
}

function stringifyQuery(query: Record<string, unknown>, prefix = ''): string {
  return Object.entries(query).flatMap(([key, value]) => {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined) return [];
    if (value !== null && typeof value === 'object') {
      const nested = stringifyQuery(value as Record<string, unknown>, name);
      return nested ? [nested] : [];
    }
    return [`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`];
  }).join('&');
}

// Swell errors come as { error: string }, { error: { message } } or { message }.
function upstreamMessage(result: { error?: unknown; message?: unknown } | null): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const { error, message } = result;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return typeof message === 'string' ? message : undefined;
}

// Backend API client with the app's credentials, the same ones Swell gives app functions.
function backendClient({ storeId, apiHost, accessToken }: BackendContext): SwellClient & { redact(text: string): string } {
  const auth = btoa(`${storeId}:${accessToken}`);
  const redact = (text: string) => text.split(accessToken).join('[redacted]').split(auth).join('[redacted]');

  async function callSwell(method: 'GET' | 'POST', path: string, query?: Record<string, unknown>, body?: unknown) {
    const search = query ? stringifyQuery(query) : '';
    const response = await fetch(new URL(`${path}${search ? `?${search}` : ''}`, apiHost), {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await response.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    const message = upstreamMessage(data as { error?: unknown; message?: unknown } | null);
    if (!response.ok || (data !== null && typeof data === 'object' && 'error' in data)) {
      throw new BackendError(message || `Swell API ${method} ${path} failed with HTTP ${response.status}`, {
        step: 'swell api',
        method,
        path,
        status: response.status,
        statusText: response.statusText,
        response: redact(text.slice(0, 2000)),
      });
    }
    return data;
  }

  return {
    get: (path, query) => callSwell('GET', path, query),
    post: (path, data) => callSwell('POST', path, undefined, data),
    redact,
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch { /* handled below */ }
  throw new RestoreError('Invalid request body');
}

function failure(err: unknown, swell: { redact(text: string): string } | null, step: string, extra: Record<string, unknown> = {}) {
  // our own errors (invalid input, not found) are messages for the merchant
  if (err instanceof RestoreError) return json({ error: err.message }, err.status);
  let details: Record<string, unknown> = { step, ...extra };
  if (err instanceof BackendError) {
    details = { ...err.details, ...extra };
  } else {
    details.exception = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  const redact = swell ? swell.redact : (text: string) => text;
  const message = redact(err instanceof Error ? err.message : String(err)) || 'Request failed';
  details = JSON.parse(redact(JSON.stringify(details)));
  // The Worker's console output reaches no log the merchant or Swell can read, so the page shows the details
  return json({ error: message, details }, 502);
}

// The signed-in user's access to orders, so the page can tell a user who can only view orders that they can't restore.
export async function adminAccess(request: Request) {
  const context = await authorizeStaff(request);
  if (context instanceof Response) return context;
  return json({ orders: context.ordersAccess });
}

// One page of deleted orders for a period. Staff with any access to orders may search.
export async function adminSearch(request: Request) {
  if (!isSameOriginJson(request)) return json({ error: 'Forbidden' }, 403);
  let options;
  try { options = parseSearchOptions(await readJsonBody(request)); }
  catch (err) { return failure(err, null, 'search'); }

  const context = await authorizeStaff(request);
  if (context instanceof Response) return context;
  const swell = backendClient(context);
  try {
    return json(await searchDeletedOrders(swell, options));
  } catch (err) {
    return failure(err, swell, 'search', { page: options.page });
  }
}

// The full `order.deleted` event of one order.
export async function adminEvent(request: Request) {
  const id = new URL(request.url).searchParams.get('id');
  if (!isObjectId(id)) return json({ error: 'Invalid event id' }, 400);

  const context = await authorizeStaff(request);
  if (context instanceof Response) return context;
  const swell = backendClient(context);
  try {
    return json(await getDeletedOrderEvent(swell, id));
  } catch (err) {
    return failure(err, swell, 'read event', { event_id: id });
  }
}

// Restore the orders of up to RESTORE_BATCH_SIZE `order.deleted` events. Needs Manage or Full access to orders.
export async function adminRestore(request: Request) {
  if (!isSameOriginJson(request)) return json({ error: 'Forbidden' }, 403);
  let eventIds;
  try { eventIds = parseEventIds((await readJsonBody(request)).event_ids); }
  catch (err) { return failure(err, null, 'restore'); }

  const context = await authorizeStaff(request);
  if (context instanceof Response) return context;
  if (context.ordersAccess !== 'full') return json({ error: VIEW_ORDERS_ONLY }, 403);
  const swell = backendClient(context);
  try {
    const results = (await restoreOrders(swell, eventIds))
      .map((result) => (result.error ? { ...result, error: swell.redact(result.error) } : result));
    return json({ results });
  } catch (err) {
    return failure(err, swell, 'restore');
  }
}
