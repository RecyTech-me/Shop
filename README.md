# RecyTech Shop

Standalone Node/Express shop for RecyTech with an Express/EJS storefront, SQLite storage, admin back office, and payment-provider integrations.

## Included

- Public storefront with product list, product page, cart, and checkout
- Admin login with product creation, edition, deletion, store settings, promo codes, orders, PDFs, and review moderation
- SQLite storage for products, settings, orders, and sessions
- Stripe Payment Element intent/order flow
- Swiss Bitcoin Pay invoice creation
- Stripe and Swiss Bitcoin Pay webhook endpoints
- Global shop reviews with admin approval

## Quick start

1. Copy `.env.example` to `.env`
2. Fill the blank secrets with local values and configure payment variables only when you want those providers enabled
3. Install dependencies with `npm install`
4. Start the app with `npm run dev` or `npm start`

The app listens on `HOST` + `PORT`.

Sessions are stored in the SQLite database, not in memory. Back up `storage/shop.db` before production maintenance or migrations.

## Quality checks

Run the full local quality gate before deploying or merging changes:

```sh
npm run verify
npm run coverage:check
```

This runs:

- `npm run check` for Node/browser/template syntax checks
- `npm run lint`
- `npm test`
- `npm audit --omit=dev --audit-level=high`
- `npm run coverage:check` runs the Node coverage report and fails below the configured minimums

For quicker iteration, run individual checks directly:

```sh
npm run check
npm test
npm run coverage
```

## Default admin bootstrap

On first start, the app creates the first admin user from:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

When `NODE_ENV=production`, `ADMIN_PASSWORD` is required to bootstrap the first admin. The app also requires these production secrets:

- `SESSION_SECRET`
- `ORDER_VIEW_TOKEN_SECRET`

Use long random values. Production startup rejects common placeholders, empty values, and short secrets, so copied example values cannot silently become real credentials. `DATABASE_PATH` can optionally point the app at a non-default SQLite file; otherwise it uses `storage/shop.db`.

## Payment configuration

Stripe:

- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`

Leave Stripe values blank until card checkout is ready. When both Stripe keys are present in production, `STRIPE_WEBHOOK_SECRET` is required so paid orders can be finalized even when customers do not return to the success page. Production startup rejects copied placeholder or fake-looking example payment secrets.

Swiss Bitcoin Pay:

- `SWISS_BITCOIN_PAY_API_URL`
- `SWISS_BITCOIN_PAY_API_KEY` (merchant API key from the Swiss Bitcoin Pay dashboard)
- `SWISS_BITCOIN_PAY_WEBHOOK_SECRET` (a long random secret you choose; the app sends it to Swiss Bitcoin Pay in the invoice webhook headers and verifies it on callbacks)

Hosted card and Bitcoin checkout require a public `SHOP_PUBLIC_URL` or `BASE_URL` in production so redirects and webhooks do not depend on request headers. `localhost` is only suitable when testing with a public tunnel.

Buttons stay disabled on the checkout page until the corresponding provider is configured.

External payment reservations are reconciled by a background cleanup task. It looks for unpaid Stripe or Swiss Bitcoin Pay orders with reserved stock older than `PAYMENT_RESERVATION_TTL_MINUTES` and then checks the provider before marking paid or releasing stock. Defaults are:

- `PAYMENT_RESERVATION_TTL_MINUTES=60`
- `PAYMENT_RESERVATION_CLEANUP_INTERVAL_MINUTES=15`
- `PAYMENT_RESERVATION_CLEANUP_LIMIT=25`

`TRUST_PROXY` controls Express' trusted proxy setting. It defaults to `1`, matching the production reverse-proxy deployment; set it to `0`/`false` for direct connections or to the appropriate hop count for another proxy setup. In production, requests must use the `SHOP_PUBLIC_URL`/`BASE_URL` host or a host listed in comma-separated `ALLOWED_HOSTS`.

Logging:

- `LOG_LEVEL` accepts `debug`, `info`, `warn`, `error`, or `silent`. Tests default to `silent`; other environments default to `info`.
- `LOG_FORMAT=json` emits structured JSON logs for production log collectors. The default is readable text.
- `REQUEST_LOGS=1` enables compact access logs with method, path, status, duration, and request ID.

Health monitoring:

- `/healthz` returns JSON readiness status and verifies SQLite can answer a query.
- `npm run health:check` probes `HEALTHCHECK_URL` when set, otherwise `SHOP_PUBLIC_URL`/`BASE_URL` plus `/healthz`, otherwise local `PORT`.
- `ALERT_WEBHOOK_URL` optionally receives a JSON POST when `npm run health:check` fails. Use this for a generic incident webhook, uptime monitor webhook, or chat/alert relay.

## Deployment notes

The GitHub deploy workflow runs `npm run verify` and `npm run coverage:check` before upload, then installs production dependencies on the server, takes a SQLite backup when the configured database file exists, restarts the service, and runs `npm run health:check` against the deployed URL. Keep the server `.env` in sync with the production requirements above and keep backups outside the deployed release directory.

The app sets security headers, CSRF protection for mutating routes, upload type/size validation, response compression, request IDs, mtime-versioned static asset URLs, immutable cache headers for versioned bundled assets, and a Content Security Policy that allows the current local assets and Stripe.js.

Product and hero uploads are validated by file signature. JPG, PNG, and WebP uploads also get a generated `-display.webp` derivative, and product/settings records point at that optimized derivative. GIF uploads are kept as originals to avoid accidentally dropping animation.

Use `npm run coverage` for Node's built-in test coverage report. Use `npm run coverage:check` for the thresholded CI gate; minimums can be adjusted with `COVERAGE_LINE_MIN`, `COVERAGE_BRANCH_MIN`, and `COVERAGE_FUNCS_MIN`.

## Architecture notes

The runtime entrypoint is `server.js`; it only creates the app and starts listening. `app.js` builds the Express app, `lib/app-infrastructure-context.js` owns configuration, database, sessions, middleware, payments, uploads, and background cleanup, and `lib/app-domain-context.js` wires repositories and domain services. Route modules receive focused contexts from `lib/route-contexts.js` so HTTP handlers do not need to construct infrastructure directly.

Repositories under `lib/repositories/` own SQLite reads/writes. Cross-row business rules live in services such as `lib/order-inventory-service.js`, `lib/payment-reservation-cleanup-service.js`, `lib/checkout-order-service.js`, and `lib/order-service.js`. Product parsing is split between `lib/product-normalizers.js`, `lib/product-configurations.js`, and `lib/product-bundles.js`. Checkout browser code is split into calculation, form-state, Stripe, and orchestration modules under `public/scripts/`.

For production monitoring, run with `LOG_FORMAT=json`, enable `REQUEST_LOGS=1` when access logs are needed, and forward stdout/stderr to the host log collector. Set `ALERT_WEBHOOK_URL` to the incident/chat/uptime relay that should receive failed `npm run health:check` probes.

## Adding a migration

Schema changes belong in `lib/db/schema.js` as named, idempotent migrations. Add a migration with a stable ID, update or add an old-schema test in `test/db-schema-migrations.test.js`, and run `npm run verify` before deploying.

Before applying migrations in production, back up `storage/shop.db` or the database pointed to by `DATABASE_PATH`. Applied migration IDs are recorded in `schema_migrations` and logged when they run.

Product categories are stored in both the legacy product columns (`category`, `categories_json`) and the normalized `product_categories` query table. Repository writes keep them synchronized so existing product rendering stays compatible while catalogue filters and admin category counts can use indexed relational rows.

## SQLite backup and restore

Back up the live database with SQLite's online backup command so WAL state is included safely:

```sh
mkdir -p storage/backups
sqlite3 storage/shop.db ".backup 'storage/backups/shop-$(date +%Y%m%d-%H%M%S).db'"
```

The repository also includes a tested backup helper:

```sh
npm run backup:sqlite
```

Pass `-- --database=/path/to/shop.db --out-dir=/secure/backup/dir` to override the defaults.

Keep backups outside the deployed release directory and protect them like secrets because order records, SMTP settings, and customer contact details are stored in SQLite.

To restore, stop the app, copy the selected backup over `storage/shop.db`, keep the matching file owner/permissions, and start the app again. Run `npm run verify` before deployment changes and take a fresh backup before migrations.

## Important routes

- `/`
- `/healthz`
- `/cart`
- `/checkout`
- `/api/products`
- `/wp-json/wc/v3/products`
- `/reviews`
- `/admin/login`
- `/admin`
- `/admin/orders`
- `/admin/promo-codes`
- `/webhooks/stripe`
- `/webhooks/swiss-bitcoin-pay`
