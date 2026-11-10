# Restore orders app frontend

The managed frontend of the Restore orders Swell app: the **Orders → Restore orders** page in the Swell dashboard. See the [app README](../README.md) for what it does.

- `src/DeletedOrders.tsx`: the page. Search form, grid with selection, sorting by date deleted or date created and 10-row pages, event data panel, restore and its result.
- `worker/index.ts`: routes `/app-api/*` requests; everything else is served from the built assets.
- `worker/swell-server.ts`: validates the staff session (and, for POST, a same-origin JSON request) and reads the user's access to orders from `/admin/api/user` (role's Orders level, or the permissions list without a role; no access is refused with 403), then runs one fixed operation:
  - `GET /app-api/admin/access`: the user's access to orders, `full` (Manage or Full) or `view`; the page uses it to hide **Restore**.
  - `POST /app-api/admin/search` `{ date_from, date_to, not_canceled, page }`: one page of 1000 `order.deleted` events, reduced to the latest deletion of each order, kept when it has an account and the order doesn't exist now, with the shipping (or billing) full name. `order_ids` lists every order on the page so the page skips older deletions on later pages (`src/search-results.ts`). The page calls it until `done`.
  - `GET /app-api/admin/event?id=`: the full `order.deleted` event.
  - `POST /app-api/admin/restore` `{ event_ids }`: restores up to 10 orders, skipping those that exist again; needs `full` access. The page asks to confirm, then sends the selection in batches and warns before the page is closed mid-restore.
- `worker/restore.ts`: the search and restore logic over a minimal Swell client.
- `src/search-results.ts`: merges search pages so only the latest deletion of each order is listed, and sorts the grid.
- `src/format.ts`: the period's day boundaries and the grid's dates and amounts, in the merchant's time zone and locale.

## Develop

```sh
npm run typecheck   # TypeScript for the page and the Worker
npm run lint
npm test            # vitest suite in ../test/unit (needs `swell login`)
npm run build       # local build; `swell app push` rebuilds anyway
```

Deploy with `swell app push` from the app root. Do not deploy directly to Cloudflare. Without the Swell request context the endpoints cannot reach the store, so test the page in the store's test environment after `swell app push`.

## Rules for this Worker

- Backend credentials come from Swell request headers at request time and stay in the Worker. Never expose them to the browser or put store values in the build.
- Protected endpoints validate `_swell_admin_session` and the user's access to orders against Swell, and only accept same-origin JSON for mutations.
- Frontend endpoints live under `/app-api`; Swell owns `/api`, `/functions` and other platform paths.
- The Worker's console output reaches no log the merchant or Swell can read: return failures to the page (`{ error, details }`), which shows them under **Error details**.
- Keep `dist/` and `.wrangler/` out of git: builds write local absolute paths into them.
