# Restore orders

A Swell admin app that finds orders deleted in a period and restores them.

Open **Orders → Restore orders** in the Swell dashboard.

## Search

Choose **Date start** and **Date end** (both days included, in your local time zone) and click **Search**. The app reads the store's `order.deleted` events created in that period and lists the deleted orders:

- An order that exists now (restored or never really gone) is not listed.
- An order deleted more than once in the period is listed once, from its latest `order.deleted` event.
- **Only not canceled** hides orders that were canceled when they were deleted.

The grid shows the order number, date created, date deleted, grand total, account ID and account email (when the account still exists), 10 orders per page. Click an order to see its full `order.deleted` event.

Deleted orders can only be found while Swell keeps their `order.deleted` events.

## Restore

Select orders with the checkboxes (the header checkbox selects the current page; **Select all** selects every result) and click **Restore**. For each order the app posts the order data from its event to `/orders` with `$restore: true`, which recreates it with its original id and number. Orders that exist again by then are skipped. The page then shows how many orders were restored, lists the ones that were not with the reason, and refreshes the grid.

Any staff user of the store who can open the app can search and restore.

## How it works

The app has no functions. Everything runs in its managed frontend (`frontend/`), see [frontend/README.md](frontend/README.md). `models/restores.json` and `content/restores.json` only add the sidebar entry; the collection stores no records.

## Develop

```sh
cd frontend
npm run typecheck
npm run lint
npm test        # Worker endpoint tests
npm run build
```

Deploy with `swell app push` from this folder.
