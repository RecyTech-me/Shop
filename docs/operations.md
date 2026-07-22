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

If the order has no provider reference, check the Stripe or Swiss Bitcoin Pay dashboard using the order number before changing local state. This can happen when the provider accepted a request but the process stopped before the reference was persisted. Swiss Bitcoin Pay webhooks can repair this automatically when the authenticated callback includes the original `extra.orderNumber`; otherwise preserve the reservation until the provider outcome is confirmed.

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

## Service Host Assumptions

The deployment workflow expects isolated `shopsite` and `shopsite-dev` systemd services, with Node.js 24 and npm available to the services and deployment user. Each service must load its own environment, restart automatically after process failure, and have write access only to its own configured SQLite database and `public/uploads` directory. The deployment user needs narrowly scoped permission to restart and stop these services.

The units are tracked at `ops/shopsite.service` and `ops/shopsite-dev.service`. Install them under `/etc/systemd/system/`, run `systemctl daemon-reload`, and enable them after verifying their paths, user, group, environment files, and isolated Node.js runtime match the target host. The units deliberately make the filesystem read-only except for their respective `storage/` and `public/uploads/` directories; add another explicit `ReadWritePaths` entry if configured writable data moves elsewhere.

The matching least-privilege sudo policy is tracked at `ops/shopsite-deploy.sudoers`. Validate it with `visudo -cf` before installing it under `/etc/sudoers.d/` with mode `0440`. It permits service restart/stop plus each environment's fixed SQLite backup entrypoint as the unprivileged service user, because hardened database files are deliberately unreadable by the deployment account. The deployment account must not receive broader passwordless sudo access.

Run one application process per SQLite database. The database and sessions support multiple connections, but request rate-limit counters and the settings cache are process-local. Horizontal scaling requires shared rate-limit/cache infrastructure and coordinated writable uploads before adding instances.
