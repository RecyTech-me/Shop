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
3. Install the lockfile-pinned dependencies with `npm ci`
4. Install Chromium for browser tests with `npx playwright install chromium`
5. Start the app with `npm run dev` or `npm start`

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
- `npm run coverage:check` runs the Node coverage report and enforces 80% line, 60% branch, and 80% function coverage by default

CI installs the Playwright Chromium runtime, then runs `npm run verify`, `npm run coverage:check`, `npm audit --audit-level=moderate`, and a Gitleaks secret scan. Configure branch protection so these checks are required before merging.

For quicker iteration, run individual checks directly:

```sh
npm run check
npm test
npm run coverage
```

See also:

- `docs/architecture.md` for request, payment, inventory, and deployment lifecycle notes.
- `docs/operations.md` for reservation cleanup and backup verification runbooks.
- `docs/release-checklist.md` for repeatable deployment checks.

## Default admin bootstrap

On first start, the app creates the first admin user from:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

When `NODE_ENV=production`, `ADMIN_PASSWORD` is required to bootstrap the first admin. The app also requires these production secrets:

- `SESSION_SECRET`
- `ORDER_VIEW_TOKEN_SECRET`

Use long random values. Production startup rejects common placeholders, empty values, and short secrets, so copied example values cannot silently become real credentials. `DATABASE_PATH` can optionally point the app at a non-default SQLite file; otherwise it uses `storage/shop.db`.

Production also requires a public HTTPS `SHOP_PUBLIC_URL` or `BASE_URL` origin, even when external payment providers are disabled. This prevents links and canonical metadata from depending on an untrusted request host and prevents a production deployment from silently serving admin credentials, sessions, or customer data over plain HTTP.

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

If `SWISS_BITCOIN_PAY_API_URL` is overridden in production, it must remain an HTTPS endpoint without embedded credentials, a query, or a fragment so the merchant key is never sent over an unsafe transport.

Hosted card and Bitcoin checkout require the canonical origin to use public HTTPS in production so redirects and webhooks do not depend on request headers. Configure only the origin (for example, `https://shop.example.ch`), without credentials, a path, query, or fragment. `localhost` is only suitable when testing with a public tunnel.

Buttons stay disabled on the checkout page until the corresponding provider is configured.

External payment reservations are reconciled by a background cleanup task. It looks for unpaid Stripe or Swiss Bitcoin Pay orders with reserved stock older than `PAYMENT_RESERVATION_TTL_MINUTES` and then checks the provider before marking paid or releasing stock. Defaults are:

- `PAYMENT_RESERVATION_TTL_MINUTES=60`
- `PAYMENT_RESERVATION_CLEANUP_INTERVAL_MINUTES=15`
- `PAYMENT_RESERVATION_CLEANUP_LIMIT=25`

If provider invoice creation has an unknown outcome (for example, a timeout after the provider may have accepted the request), the app intentionally keeps the order pending and stock reserved. An authenticated Swiss Bitcoin Pay webhook can recover the missing invoice reference from the order number attached to the invoice. Cleanup also keeps reservations whose provider reference is still missing; operators must confirm the provider state before releasing them.

`TRUST_PROXY` controls Express' trusted proxy setting. It defaults to `1`, matching the production reverse-proxy deployment; set it to `0`/`false` for direct connections or to the appropriate hop count for another proxy setup. In production, requests must use the `SHOP_PUBLIC_URL`/`BASE_URL` host or a host listed in comma-separated `ALLOWED_HOSTS`.

Logging:

- `LOG_LEVEL` accepts `debug`, `info`, `warn`, `error`, or `silent`. Tests default to `silent`; other environments default to `info`.
- `LOG_FORMAT=json` emits structured JSON logs for production log collectors. The default is readable text.
- `REQUEST_LOGS=1` enables compact access logs with method, path, status, duration, and request ID.

Production SMTP uses implicit TLS when `SMTP_SECURE=1`; otherwise it requires a successful STARTTLS upgrade. This prevents SMTP credentials and order/customer data from falling back to cleartext delivery.

Health monitoring:

- `/healthz` returns JSON readiness status and verifies SQLite can answer a query.
- `npm run health:check` probes `HEALTHCHECK_URL` when set, otherwise `SHOP_PUBLIC_URL`/`BASE_URL` plus `/healthz`, otherwise local `PORT`.
- `ALERT_WEBHOOK_URL` optionally receives a JSON POST when `npm run health:check` fails. Use this for a generic incident webhook, uptime monitor webhook, or chat/alert relay.
- `HEALTHCHECK_ATTEMPTS` and `HEALTHCHECK_RETRY_DELAY_MS` optionally retry startup probes before alerting; the deploy workflow uses ten attempts at two-second intervals.

## Deployment notes

The GitHub deploy workflow runs `npm run verify` and `npm run coverage:check` before upload. A `dev` push deploys only to `/home/recytech/apps/shopsite-dev`, `shopsite-dev.service`, and `https://dev.shop.recytech.me`; a `main` push deploys only to `/home/recytech/apps/shopsite`, `shopsite.service`, and `https://shop.recytech.me`. The two targets use separate environment files, SQLite databases, uploads, staging directories, rollback snapshots, services, and ports.

Each deployment uploads into its target-specific staging directory, installs production dependencies there, creates and verifies a SQLite backup, then promotes the staged files while preserving `.env`, `storage/`, and `public/uploads/`. It snapshots the preceding application release and restores that code automatically if restart or health validation fails. Database migrations are additive and are not rolled back automatically. Deployments are serialized per branch and are not cancelled mid-flight.

Configure `DEPLOY_KNOWN_HOSTS` with the trusted SSH host-key line obtained through a verified channel (for a non-default port, use the `[host]:port` known-hosts form). The workflow deliberately does not trust a key discovered with `ssh-keyscan` during deployment.

The deployment workflow requires these GitHub Actions secrets:

- `DEPLOY_SSH_KEY`: unencrypted private key for the restricted deployment account.
- `DEPLOY_KNOWN_HOSTS`: pinned SSH host-key line verified through an existing trusted connection.
- `DEPLOY_HOST`, `DEPLOY_PORT`, and `DEPLOY_USER`: SSH endpoint. `DEPLOY_PORT` may be omitted to use port 22.
- `ALERT_WEBHOOK_URL`: optional incident webhook for a failed health check.

Branch-specific paths, URLs, and service names are fixed in the workflow and validated again on the remote host to prevent cross-environment deployment. The remote host must provide Node.js 24 at `/opt/shopsite-node/bin`, and the deployment account must be able to write each live, staging, and previous-release directory. Keep its sudo access limited to restarting or stopping `shopsite` and `shopsite-dev`, plus their fixed backup entrypoints; it does not require general root access. The workflow validates the key format, pinned host key, target mapping, non-interactive SSH access, and destination permissions before uploading files.

The app sets security headers, CSRF protection for mutating routes, upload type/size validation, response compression, request IDs, mtime-versioned static asset URLs, immutable cache headers for versioned bundled assets, and a Content Security Policy that allows the current local assets and Stripe.js.

Product and hero uploads are validated by file signature. JPG, PNG, and WebP uploads also get a generated `-display.webp` derivative, and product/settings records point at that optimized derivative. GIF uploads are kept as originals to avoid accidentally dropping animation.

Use `npm run coverage` for Node's built-in test coverage report. Use `npm run coverage:check` for the thresholded CI gate; its 80% line, 60% branch, and 80% function minimums can be adjusted with `COVERAGE_LINE_MIN`, `COVERAGE_BRANCH_MIN`, and `COVERAGE_FUNCS_MIN`.

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

Verify a backup by restoring/checking a temporary copy:

```sh
npm run backup:verify -- --backup=/secure/backup/dir/shop-YYYYMMDD-HHMMSS.db
```

Keep backups outside the deployed release directory and protect them like secrets because order records, SMTP settings, and customer contact details are stored in SQLite. The backup helper and database initializer enforce owner-only (`0600`) file permissions.

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
