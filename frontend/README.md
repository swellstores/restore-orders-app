# Restore orders app frontend

The managed frontend of the Restore orders Swell app: the **Orders → Restore orders** page in the Swell dashboard. See the [app README](../README.md) for what it does.

- `src/DeletedOrders.tsx`: the page. Search form, grid with selection, sorting by date deleted or date created and 10-row pages, event data panel, restore and its result.
- `worker/index.ts`: routes `/app-api/*` requests; everything else is served from the built assets.
- `worker/swell-server.ts`: validates the staff session (and, for POST, a same-origin JSON request), then runs one fixed operation:
  - `POST /app-api/admin/search` `{ date_from, date_to, not_canceled, page }`: one page of 1000 `order.deleted` events, reduced to the latest deletion of each order, kept when it has an account and the order doesn't exist now, with the shipping (or billing) full name. `order_ids` lists every order on the page so the page skips older deletions on later pages (`src/search-results.ts`). The page calls it until `done`.
  - `GET /app-api/admin/event?id=`: the full `order.deleted` event.
  - `POST /app-api/admin/restore` `{ event_ids }`: restores up to 10 orders, skipping those that exist again; the page sends the selection in batches.
- `worker/restore.ts`: the search and restore logic over a minimal Swell client.

## Develop

```sh
npm run typecheck   # TypeScript for the page and the Worker
npm run lint
npm test            # Worker endpoint tests (node --test)
npm run build       # local build; `swell app push` rebuilds anyway
```

Deploy with `swell app push` from the app root. Do not deploy directly to Cloudflare. Without the Swell request context the endpoints cannot reach the store, so test the page in the store's test environment after `swell app push`.

## Rules for this Worker

- Backend credentials come from Swell request headers at request time and stay in the Worker. Never expose them to the browser or put store values in the build.
- Protected endpoints validate `_swell_admin_session` against Swell and only accept same-origin JSON for mutations.
- Frontend endpoints live under `/app-api`; Swell owns `/api`, `/functions` and other platform paths.
- Keep `dist/` and `.wrangler/` out of git: builds write local absolute paths into them.
