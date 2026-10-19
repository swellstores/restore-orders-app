# Restore orders

A Swell admin app that finds orders deleted in a period and restores them.

## Setup

1. Install the app in the store. Test and live are separate environments: install it in each one you need, and open it
   from that environment's dashboard. The app only sees orders deleted in the environment it's opened in.
2. Open **Orders → Restore orders** in the Swell dashboard.

## Features

### Search

Choose **Date start** and **Date end** and click **Search**. Both days are included, in your local time zone; the form
starts with the last 30 days. The app reads the store's `order.deleted` events created in that period and lists the
deleted orders:

- An order that exists now (restored, or recreated with the same id) is not listed.
- An order deleted more than once in the period is decided by its latest `order.deleted` event in the period: it is
  listed and restored from that event only, and the filters below apply to that event. An older deletion is never
  listed instead.
- Orders without an account (empty `account_id`) are not listed.
- **Only not canceled** hides orders that were canceled (`canceled: true`) when they were deleted. Without it, canceled
  orders are listed with a **Canceled** badge.

### Grid

The grid shows 10 orders per page with these columns:

| Column | Value |
|---|---|
| Order number | The order's number; a click shows its event data |
| Date created | When the order was created |
| Date deleted | When the order was deleted (the event's date) |
| Grand total | The order's grand total in its currency |
| Account ID | The order's `account_id` |
| Full name | The shipping name (`name`, or first and last name); when it's empty, the billing name the same way |

**Sort by** above the grid orders the results newest first by **Date deleted** (default) or by **Date created**. Orders
without that date go last; orders with the same date keep the latest deletion first. Sorting applies at once, without
searching again.

Click an order to see its full `order.deleted` event below the grid; click it again or **Close** to hide it.

### Restore

Select orders with the checkboxes (the header checkbox selects the current page, **Select all** selects every result,
**Clear selection** clears it) and click **Restore**. For each order the app posts the order data from its event to
`/orders` with `$restore: true`, which recreates it with its original id and number. Orders that exist again by then
are skipped. A failure on one order doesn't stop the others.

The page then shows how many orders were restored, lists the ones that were not with the reason, and searches again so
restored orders leave the grid.

### Access

Any staff user of the store who can open the app in the dashboard can search and restore. The app's endpoints check the
dashboard session with Swell on every request, and accept restore and search requests only from the app's own page.

## Settings

The app has no settings.

## Limits

- Deleted orders can only be found while Swell keeps their `order.deleted` events.
- The search reads 1,000 events per request and checks orders 100 at a time, so a long period with many deletions takes
  several requests; the page shows the progress.
- Restore sends 10 orders per request; a larger selection is sent in several requests.

## How it works

The app has no functions. Everything runs in its managed frontend (`frontend/`), see
[frontend/README.md](frontend/README.md).

```
models/restores.json           placeholder collection for the sidebar entry; stores no records
content/restores.json          sidebar entry Orders → Restore orders, opens the frontend
frontend/src/                  the page (React)
frontend/worker/               the Worker: staff check, search, event, restore
test/unit/                     vitest tests for the Worker endpoints and the page's result merging
assets/                        icon and screenshots
```

## Develop

From the app folder:

```sh
npm install
npm run typecheck              # app, tests and frontend
npm test                       # vitest; reads the Swell CLI session, so run `swell login` first
cd frontend
npm run lint
npm run build                  # local build; `swell app push` rebuilds anyway
```

Deploy to the test environment with `swell app push` from the app folder.
