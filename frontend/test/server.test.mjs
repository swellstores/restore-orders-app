import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { adminEvent, adminRestore, adminSearch } from '../worker/swell-server.ts';
import { mergeSearchPage } from '../src/search-results.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const origin = 'https://app.example.invalid';
const headers = {
  'Swell-Store-Id': 'example',
  'Swell-Admin-Url': 'https://example.swell.store',
  'Swell-API-Host': 'https://api.example.invalid',
  'Swell-Access-Token': 'private-fixture-token',
};
const session = '_swell_admin_session=fixture';

const post = (path, body, { cookie = session, extra = {} } = {}) => new Request(`${origin}${path}`, {
  method: 'POST',
  headers: {
    ...headers, Origin: origin, 'Content-Type': 'application/json',
    ...(cookie ? { Cookie: cookie } : {}), ...extra,
  },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const get = (path, { cookie = session } = {}) => new Request(`${origin}${path}`, {
  headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
});

const id = (n) => n.toString(16).padStart(24, '0');
const searchBody = { date_from: '2026-10-01T00:00:00.000Z', date_to: '2026-10-20T00:00:00.000Z', page: 1 };

const noPlatformCalls = () => {
  globalThis.fetch = () => { throw new Error('Must not contact the platform'); };
};

// Routes mocked platform calls as "METHOD /path"; handlers get the URL and the parsed body.
function mockPlatform(routes) {
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || 'GET';
    assert.equal(options.redirect, 'manual');
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, path: url.pathname, url, body });
    if (method === 'GET' && url.pathname === '/admin/api/session') {
      assert.equal(options.headers['X-Session'], 'fixture');
      return Response.json({ user_id: 'staff', client_id: 'example' });
    }
    assert.equal(options.headers.Authorization, `Basic ${btoa('example:private-fixture-token')}`);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) throw new Error(`Unexpected request ${method} ${url.pathname}`);
    const result = await route(url, body);
    return result instanceof Response ? result : Response.json(result);
  };
  return calls;
}

// Values of `prefix[$in][N]` query parameters
const inValues = (url, prefix) => [...url.searchParams.entries()]
  .filter(([key]) => key.startsWith(`${prefix}[$in]`)).map(([, value]) => value);

for (const [name, request] of [
  ['cross-origin search', () => post('/app-api/admin/search', searchBody, { extra: { Origin: 'https://evil.example' } })],
  ['form-encoded search', () => post('/app-api/admin/search', searchBody, { extra: { 'Content-Type': 'text/plain' } })],
  ['cross-origin restore', () => post('/app-api/admin/restore', { event_ids: [id(1)] }, { extra: { Origin: 'https://evil.example' } })],
]) {
  test(`rejects ${name} without contacting the platform`, async () => {
    noPlatformCalls();
    const handler = name.includes('restore') ? adminRestore : adminSearch;
    assert.equal((await handler(request())).status, 403);
  });
}

for (const cookie of [null, '_swell_admin_session=%ZZ']) {
  test(`rejects missing or malformed session: ${cookie}`, async () => {
    noPlatformCalls();
    assert.equal((await adminSearch(post('/app-api/admin/search', searchBody, { cookie }))).status, 401);
    assert.equal((await adminEvent(get(`/app-api/admin/event?id=${id(1)}`, { cookie }))).status, 401);
    assert.equal((await adminRestore(post('/app-api/admin/restore', { event_ids: [id(1)] }, { cookie }))).status, 401);
  });
}

for (const result of [{}, { user_id: 'user', client_id: 'other-store' }]) {
  test(`rejects invalid or other-store session: ${JSON.stringify(result)}`, async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json(result); };
    assert.equal((await adminSearch(post('/app-api/admin/search', searchBody))).status, 401);
    assert.equal(calls, 1);
  });
}

test('rejects session redirects without following them', async () => {
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example' } });
  };
  assert.equal((await adminSearch(post('/app-api/admin/search', searchBody))).status, 401);
});

for (const [name, body] of [
  ['invalid JSON', '{'],
  ['missing dates', {}],
  ['invalid start date', { ...searchBody, date_from: 'yesterday' }],
  ['end before start', { ...searchBody, date_from: searchBody.date_to, date_to: searchBody.date_from }],
  ['invalid page', { ...searchBody, page: 0 }],
]) {
  test(`search rejects ${name}`, async () => {
    noPlatformCalls();
    assert.equal((await adminSearch(post('/app-api/admin/search', body))).status, 400);
  });
}

test('search lists each deleted order by its latest event, when that has an account, with its full name', async () => {
  const events = [
    { id: id(101), date_created: '2026-10-19T10:00:00.000Z', data: { id: id(1), number: '1001', date_created: '2026-10-01T00:00:00.000Z', grand_total: 25.5, currency: 'EUR', account_id: id(51), shipping: { name: ' Ann Lee ' }, billing: { name: 'Billing Name' } } },
    { id: id(102), date_created: '2026-10-18T10:00:00.000Z', data: { id: id(2), number: '1002', grand_total: 10, account_id: id(52) } },
    { id: id(103), date_created: '2026-10-17T10:00:00.000Z', data: { id: id(1), number: '1001', account_id: id(51) } },
    { id: id(104), date_created: '2026-10-16T10:00:00.000Z', data: { id: id(3), number: '1003', canceled: true, account_id: id(53), shipping: { name: null, first_name: 'Bob', last_name: 'Stone' } } },
    { id: id(105), date_created: '2026-10-15T10:00:00.000Z', data: {} },
    { id: id(106), date_created: '2026-10-14T10:00:00.000Z', data: { id: id(4), number: '1004', account_id: null, shipping: { name: 'No Account' } } },
    { id: id(107), date_created: '2026-10-13T10:00:00.000Z', data: { id: id(5), number: '1005', account_id: '', shipping: { name: 'Empty Account' } } },
    { id: id(108), date_created: '2026-10-12T10:00:00.000Z', data: { id: id(6), number: '1006', account_id: id(56), shipping: { name: '', first_name: null }, billing: { first_name: 'Cara' } } },
    { id: id(109), date_created: '2026-10-11T10:00:00.000Z', data: { id: id(7), number: '1007', account_id: id(57) } },
    // latest deletion without an account: the older one with an account is not listed instead
    { id: id(110), date_created: '2026-10-10T10:00:00.000Z', data: { id: id(8), number: '1008', account_id: null } },
    { id: id(111), date_created: '2026-10-09T10:00:00.000Z', data: { id: id(8), number: '1008', account_id: id(58) } },
  ];
  const calls = mockPlatform({
    'GET /events': () => ({ count: events.length, results: events }),
    'GET /orders': () => ({ count: 1, results: [{ id: id(2) }] }),
  });
  const response = await adminSearch(post('/app-api/admin/search', searchBody));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const row = (eventId, orderId, number, dateDeleted, name, extra = {}) => ({
    event_id: id(eventId), order_id: id(orderId), number, date_created: null, date_deleted: dateDeleted,
    grand_total: null, currency: null, account_id: id(orderId + 50), name, canceled: false, ...extra,
  });
  assert.deepEqual(await response.json(), {
    page: 1, pages: 1, count: 11, done: true,
    order_ids: [1, 2, 3, 4, 5, 6, 7, 8].map(id),
    results: [
      row(101, 1, '1001', '2026-10-19T10:00:00.000Z', 'Ann Lee', { date_created: '2026-10-01T00:00:00.000Z', grand_total: 25.5, currency: 'EUR' }),
      row(104, 3, '1003', '2026-10-16T10:00:00.000Z', 'Bob Stone', { canceled: true }),
      row(108, 6, '1006', '2026-10-12T10:00:00.000Z', 'Cara'),
      row(109, 7, '1007', '2026-10-11T10:00:00.000Z', null),
    ],
  });

  const eventsUrl = calls.find((call) => call.path === '/events').url;
  assert.equal(eventsUrl.searchParams.get('where[type]'), 'order.deleted');
  assert.equal(eventsUrl.searchParams.get('where[date_created][$gte]'), searchBody.date_from);
  assert.equal(eventsUrl.searchParams.get('where[date_created][$lt]'), searchBody.date_to);
  assert.equal(eventsUrl.searchParams.get('where[data.canceled][$ne]'), null);
  assert.equal(eventsUrl.searchParams.get('sort'), 'date_created desc');
  assert.match(eventsUrl.searchParams.get('fields'), /data\.shipping\.name.*data\.billing\.last_name/);
  assert.deepEqual(inValues(calls.find((call) => call.path === '/orders').url, 'where[id]'), [id(1), id(2), id(3), id(6), id(7)]);
});

test('search with "only not canceled" leaves out orders canceled at their latest deletion', async () => {
  const event = (eventId, orderId, canceled) => ({
    id: id(eventId), date_created: `2026-10-1${9 - (eventId % 10)}T10:00:00.000Z`,
    data: { id: id(orderId), number: `100${orderId}`, account_id: id(50 + orderId), ...(canceled === undefined ? {} : { canceled }) },
  });
  const calls = mockPlatform({
    'GET /events': () => ({
      count: 2500,
      results: [
        event(101, 1, true), // canceled
        event(102, 2, false),
        event(103, 3), // no canceled field
        event(104, 4, false), // latest deletion not canceled
        event(105, 4, true),
        event(106, 5, true), // latest deletion canceled
        event(107, 5, false),
      ],
    }),
    'GET /orders': () => ({ results: [] }),
  });
  const result = await (await adminSearch(post('/app-api/admin/search', { ...searchBody, not_canceled: true, page: 2 }))).json();
  assert.deepEqual(
    { ...result, results: result.results.map((row) => [row.event_id, row.canceled]) },
    {
      page: 2, pages: 3, count: 2500, done: false,
      results: [[id(102), false], [id(103), false], [id(104), false]], order_ids: [1, 2, 3, 4, 5].map(id),
    },
  );
  const eventsUrl = calls.find((call) => call.path === '/events').url;
  assert.equal(eventsUrl.searchParams.get('page'), '2');
  assert.deepEqual(inValues(calls.find((call) => call.path === '/orders').url, 'where[id]'), [id(2), id(3), id(4)]);
});

test('search failures return safe details without credentials', async () => {
  mockPlatform({
    'GET /events': () => Response.json({ error: 'Bad private-fixture-token' }, { status: 500 }),
  });
  const response = await adminSearch(post('/app-api/admin/search', searchBody));
  assert.equal(response.status, 502);
  const text = await response.text();
  assert(!text.includes('private-fixture-token'));
  assert.equal(JSON.parse(text).details.path, '/events');
});

test('event returns the full deleted order event only', async () => {
  const event = { id: id(101), type: 'order.deleted', data: { id: id(1), number: '1001', items: [] } };
  mockPlatform({
    [`GET /events/${id(101)}`]: () => event,
    [`GET /events/${id(102)}`]: () => ({ id: id(102), type: 'account.deleted', data: {} }),
  });
  assert.deepEqual(await (await adminEvent(get(`/app-api/admin/event?id=${id(101)}`))).json(), event);
  assert.equal((await adminEvent(get(`/app-api/admin/event?id=${id(102)}`))).status, 404);
});

test('event rejects invalid ids without contacting the platform', async () => {
  noPlatformCalls();
  assert.equal((await adminEvent(get('/app-api/admin/event?id=../orders'))).status, 400);
  assert.equal((await adminEvent(get('/app-api/admin/event'))).status, 400);
});

for (const [name, body] of [
  ['no ids', { event_ids: [] }],
  ['invalid ids', { event_ids: ['../orders'] }],
  ['too many ids', { event_ids: Array.from({ length: 11 }, (_, n) => id(n + 1)) }],
]) {
  test(`restore rejects ${name}`, async () => {
    noPlatformCalls();
    assert.equal((await adminRestore(post('/app-api/admin/restore', body))).status, 400);
  });
}

test('restore posts each deleted order with $restore, skips existing ones and continues after failures', async () => {
  const events = {
    [id(101)]: { id: id(101), type: 'order.deleted', data: { id: id(1), number: '1001', grand_total: 5, items: [{ product_id: id(9), quantity: 1 }] } },
    [id(102)]: { id: id(102), type: 'order.deleted', data: { id: id(2), number: '1002' } },
    [id(103)]: { id: id(103), type: 'order.deleted', data: { id: id(3), number: '1003' } },
    [id(104)]: { id: id(104), type: 'order.created', data: { id: id(4) } },
  };
  const calls = mockPlatform({
    ...Object.fromEntries(Object.entries(events).map(([eventId, event]) => [`GET /events/${eventId}`, () => event])),
    'GET /orders': (url) => ({ results: inValues(url, 'where[id]').includes(id(2)) ? [{ id: id(2) }] : [] }),
    'POST /orders': (_url, body) => (body.id === id(3)
      ? Response.json({ error: 'Rejected private-fixture-token' }, { status: 400 })
      : { ...body, $restore: undefined }),
  });
  const response = await adminRestore(post('/app-api/admin/restore', { event_ids: [id(101), id(102), id(103), id(104)] }));
  assert.equal(response.status, 200);
  const { results } = await response.json();
  assert.deepEqual(results, [
    { event_id: id(101), order_id: id(1), number: '1001', status: 'restored' },
    { event_id: id(102), order_id: id(2), number: '1002', status: 'skipped', error: 'The order already exists' },
    { event_id: id(103), order_id: id(3), number: '1003', status: 'failed', error: 'Rejected [redacted]' },
    { event_id: id(104), order_id: null, number: null, status: 'failed', error: 'Deleted order event not found' },
  ]);
  const posts = calls.filter((call) => call.method === 'POST');
  assert.deepEqual(posts.map((call) => call.body), [
    { ...events[id(101)].data, $restore: true },
    { ...events[id(103)].data, $restore: true },
  ]);
});

test('merged search pages list only the latest deletion of each order in the period', () => {
  const found = new Map();
  const seen = new Set();
  const row = (eventId, orderId) => ({ event_id: id(eventId), order_id: id(orderId) });
  // page 1 (newest): order 1 listed, order 2 deleted but filtered out (e.g. canceled)
  mergeSearchPage(found, seen, { results: [row(101, 1)], order_ids: [id(1), id(2)] });
  // page 2 (older): older deletions of orders 1 and 2 must not be listed; order 3 is new
  mergeSearchPage(found, seen, { results: [row(201, 1), row(202, 2), row(203, 3)], order_ids: [id(1), id(2), id(3)] });
  assert.deepEqual([...found.values()], [row(101, 1), row(203, 3)]);
});
