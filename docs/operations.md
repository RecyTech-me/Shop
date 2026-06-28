# Operations Runbook

## Stale Payment Reservation Cleanup

The app logs stale reservation cleanup summaries under `payments.reservation_cleanup` with these counters:

- `checked`
- `paid`
- `released`
- `kept`
- `skipped`
- `failed`

If `failed > 0`, do not manually release stock first. Check provider availability and logs for the order number. A failed cleanup means the app could not confirm provider state, so the reservation is intentionally kept. After the provider is reachable again, wait for the next cleanup interval or run the maintenance task from an application shell that has the production environment loaded.

Relevant settings:

- `PAYMENT_RESERVATION_TTL_MINUTES`
- `PAYMENT_RESERVATION_CLEANUP_INTERVAL_MINUTES`
- `PAYMENT_RESERVATION_CLEANUP_LIMIT`

## Backup Restore Drill

Run this drill outside the production database path:

1. Create a backup:

   ```sh
   npm run backup:sqlite -- --database=storage/shop.db --out-dir=storage/backups
   ```

2. Verify the backup without touching production:

   ```sh
   npm run backup:verify -- --backup=storage/backups/<backup-file>.db
   ```

3. Confirm the script reports `SQLite backup verified` and `Orders table present: yes`.

For a real restore, stop the app, copy the selected backup over `storage/shop.db`, preserve ownership/permissions, start the app, and check `/healthz`.

## Monitoring Wiring

Production should set:

- `LOG_FORMAT=json`
- `REQUEST_LOGS=1` if access-log volume is acceptable
- `ALERT_WEBHOOK_URL`

Forward stdout/stderr to the host log collector and configure an external uptime check against `/healthz`.
