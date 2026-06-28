# Architecture Notes

## Request Lifecycle

`server.js` starts the HTTP server and installs graceful shutdown handlers. `app.js` creates the Express app, builds the application context, registers webhook routes before body parsing, installs middleware, registers page/API/admin routes, and finally registers fallback handlers.

`lib/app-infrastructure-context.js` owns environment/config parsing, database initialization, payment provider clients, settings cache, repositories, and shared rate limiters. `lib/app-domain-context.js` builds domain services such as checkout, mail, payments, uploads, presentation helpers, and maintenance tasks. `lib/route-contexts.js` passes narrower dependency groups into route modules.

## Payment Lifecycle

Card checkout creates or reuses a Stripe PaymentIntent from `/checkout/stripe/intent`. The browser validates Stripe Elements before calling `/checkout/stripe/prepare`, so stock is not reserved for locally invalid card forms. Prepare verifies the session draft, amount, currency, and PaymentIntent state before creating a reserved order and attaching order metadata to Stripe.

Bitcoin checkout creates a pending order, reserves stock, then requests a Swiss Bitcoin Pay invoice. If invoice creation fails, the order is marked failed and the reservation is released.

Stripe and Swiss Bitcoin Pay webhooks are CSRF-exempt but provider-verified. Paid callbacks mark orders paid. Failed, canceled, refunded, or expired states release reserved stock through the order inventory service.

## Inventory Reservation Lifecycle

External payment orders reserve stock before payment finalization. Reservation metadata is stored on the order. `lib/order-inventory-service.js` owns stock consume/restore behavior and ensures paid finalization does not double-consume reserved inventory.

`lib/payment-reservation-cleanup-service.js` reconciles stale unpaid reservations. It checks the payment provider before taking action:

- Succeeded Stripe/SBP payments are marked paid.
- Canceled Stripe intents and expired SBP invoices release stock.
- Provider outages increment the cleanup `failed` counter and keep stock reserved.
- Stripe intents still requiring a payment method are canceled first; stock is released only if Stripe confirms cancellation.

## Deployment And Backup Lifecycle

CI runs install, verify, coverage, moderate audit, and secret scanning. The deploy workflow validates before upload, installs production dependencies on the server, backs up SQLite before restart/migration, restarts the service, and runs `/healthz`.

Use `npm run backup:sqlite` for online SQLite backups and `npm run backup:verify -- --backup=/path/to/backup.db` to restore/check a backup copy in a temporary location without touching production.
