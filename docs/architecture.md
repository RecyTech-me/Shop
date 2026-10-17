# Architecture Notes

## Request Lifecycle

`server.js` starts the HTTP server and installs graceful shutdown handlers. `app.js` creates the Express app, builds the application context, registers webhook routes before body parsing, installs middleware, registers page/API/admin routes, and finally registers fallback handlers.

`lib/app-infrastructure-context.js` owns environment/config parsing, database initialization, payment provider clients, settings cache, repositories, and shared rate limiters. `lib/app-domain-context.js` builds domain services such as checkout, mail, payments, uploads, presentation helpers, and maintenance tasks. `lib/route-contexts.js` passes narrower dependency groups into route modules.

## Payment Lifecycle

Card checkout creates or reuses a Stripe PaymentIntent from `/checkout/stripe/intent`. PaymentIntent creation uses a deterministic Stripe idempotency key derived from the session checkout attempt and priced cart, preventing concurrent retries from creating duplicate intents. The browser validates Stripe Elements before calling `/checkout/stripe/prepare`, so stock is not reserved for locally invalid card forms. Prepare verifies the session draft, amount, currency, and PaymentIntent state before creating a reserved order and attaching order metadata to Stripe. All checkout methods use a session-bound idempotency key backed by a unique order column, so a repeated submission reuses its original order, including the promo redemption already reserved by that order.

Bitcoin checkout creates a pending order, reserves stock, then requests a Swiss Bitcoin Pay invoice. A definitive provider rejection marks the order failed and releases the reservation. A timeout, upstream failure, or malformed success response has an unknown outcome, so the order remains pending and stock stays reserved. An authenticated provider webhook can recover a missing invoice reference from the order number embedded in the original invoice request.

Stripe and Swiss Bitcoin Pay webhooks are CSRF-exempt but provider-verified. Paid callbacks mark orders paid. A failed Stripe payment attempt remains pending because the same PaymentIntent can be retried; canceled or expired unpaid states release reserved stock through the order inventory service. A refund status records an already completed refund; changing the local status does not call a payment provider. Valid provider callbacks return a retryable response while their order is not yet visible or a database mutation fails.

## Inventory Reservation Lifecycle

Pending checkout and manual orders reserve stock before payment finalization, including transfer and cash orders. Reservation metadata is stored on the order. `lib/order-inventory-service.js` owns stock consume/restore behavior, serializes inventory transitions across SQLite connections, and ensures paid finalization does not double-consume reserved inventory.

Products referenced by an active reservation cannot be deleted, including components referenced through a bundle. This keeps reserved order snapshots and their eventual inventory transition resolvable.

Superadmins can purge an offline test order from its detail page. This path is deliberately unavailable for Stripe, Swiss Bitcoin Pay, provider-referenced, refunded, or legacy orders without trustworthy inventory metadata. The purge restores an active reservation—or the direct stock consumption recorded by a paid manual order—including global stock, configuration quantities, and service tags. It also reverses any reserved or redeemed promo-code usage and deletes the order in one SQLite transaction. A previously released reservation is not restored twice. Ordinary paid orders remain immutable and provider-backed payment history cannot be purged through the administration UI.

`lib/payment-reservation-cleanup-service.js` reconciles stale unpaid reservations. It checks the payment provider before taking action:

- Succeeded Stripe/SBP payments are marked paid.
- Canceled Stripe intents and expired SBP invoices release stock.
- Provider outages increment the cleanup `failed` counter and keep stock reserved.
- Missing provider references increment `failed` and keep stock reserved for operator/provider verification.
- Stripe intents still requiring a payment method are canceled first; stock is released only if Stripe confirms cancellation.

Graceful shutdown stops new cleanup scheduling and waits for any in-flight reconciliation before closing SQLite. Cleanup failures produce a failed shutdown status instead of being hidden.

## Deployment And Backup Lifecycle

CI runs install, verify, coverage, moderate audit, and secret scanning. The deploy workflow validates before upload, installs production dependencies on the server, verifies an online SQLite backup before restart/migration, snapshots the prior application release, restarts the service, and retries `/healthz`. A failed restart or health check restores the prior application code when available; additive database migrations are not reversed automatically.

Use `npm run backup:sqlite` for online SQLite backups and `npm run backup:verify -- --backup=/path/to/backup.db` to restore/check a backup copy in a temporary location without touching production.

## Order email delivery

Checkout inserts two `mail_outbox` records (team notification and customer confirmation) in the same SQLite transaction as the order and inventory reservation. Unique `(order_id, kind)` prevents duplicate enqueue on checkout retries. Existing orders are not backfilled. Manual admin-created orders retain their existing explicit email workflow. The queue contains order references and delivery status, not message bodies or credentials; deletion cascades with the order. Existing database backups include the queue, and restores may replay pending deliveries.

The application processes at most ten messages per batch at startup, every minute, and after checkout creation. SMTP never blocks the checkout response. Conditional claims with five-minute leases support recovery after interruption and concurrent processes. Each message has up to five attempts with 1/2/4/8-minute backoff. Failed deliveries and safe error codes appear on the order detail page; an authenticated, CSRF-protected retry action resets only unsent pending/failed messages. Cancelled, failed and refunded orders are skipped. Shutdown waits for active delivery work. SMTP success means acceptance by the mail server, not inbox delivery. A stable Message-ID helps identify duplicates, but a crash after SMTP acceptance and before committing success can still result in a repeated message.

Messages are built from the current order at delivery time. Customer confirmations contain the order summary and actual payment state; pending payments are never described as received. They exclude admin notes and administration URLs. The queue stores only redacted errors; SMTP credentials and raw provider responses are not logged. SMTP configuration is selected as a group: when an admin SMTP host is set, its associated port, TLS and credentials are used; otherwise environment SMTP transport values apply together. SMTP passwords preserve whitespace. Production requires TLS. A connection/authentication test in settings sends no email and cannot prove inbox deliverability.

The migration only adds an outbox table and index. Older code can run against the extended database, but will not process pending outbox records. Keep the database when rolling back; resume delivery with compatible code. No historical orders are automatically emailed on deployment.
