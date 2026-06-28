# RecyTech Shop Code Quality Audit

Date: 2026-06-28

Audit target: current working tree, including the uncommitted cleanup changes present during this pass.

## Executive Summary

The codebase is in strong shape for a small custom Express/EJS commerce app. Since the earlier audits, the main readiness items have been handled: payment inventory is reserved/released for hosted checkout flows, stale external-payment reservations are reconciled by a provider-aware cleanup task, production payment configuration fails fast and rejects placeholder secrets, request host/proxy behavior is configurable, Stripe prepare is bound to the session draft and only reserves stock after local Stripe Elements validation succeeds, product parsing and checkout state are split into focused modules, product categories are normalized into a query table while legacy JSON columns remain compatible, pack availability filters use hydrated component stock and refill pages after post-hydration filtering, order inventory lifecycle is isolated from paid-finalization, promo finalization honors the accepted order snapshot, order document rendering is split by layout/content/orchestration, uploads create web-optimized derivatives, admin orders are paginated, bundled assets use versioned immutable URLs, request IDs are emitted, structured logging is configurable, `/healthz` plus `npm run health:check` covers readiness checks with optional alert webhook delivery, SQLite backups have a tested helper, the deploy workflow takes a backup before restart/migration, and operational scripts are import-safe.

This is no longer a fragile prototype. It is a maintainable small-shop codebase with strong tests, solid security defaults, current dependencies, and a clear architecture. The remaining caveat is release process, not a known code blocker: the working tree is still intentionally large and should be reviewed, staged, and committed as a coherent change set before deployment.

Overall cleanliness/readiness rating: **8.9 / 10**

Practical ceiling before commit/PR review and production monitoring wiring: **9.0 / 10**.

## Ratings

| Area | Rating | Notes |
| --- | ---: | --- |
| Readability | 8.8 / 10 | Entry points, app context, routes, checkout state, product parsing, order inventory lifecycle, cleanup service, and document rendering are easier to scan; some route modules remain large. |
| Maintainability | 8.8 / 10 | Infrastructure/domain/route contexts, services, repositories, inventory lifecycle, checkout helpers, document helpers, and tests are well separated; context bags can still be slimmed over time. |
| Optimization | 8.5 / 10 | Lazy cart locals, lighter admin rows, normalized category queries, indexed price ranges, SQL filters, upload derivatives, pagination, compression, cached asset versions, and pack page refill help. JSON-backed configuration data remains the main scaling compromise. |
| Security readiness | 8.8 / 10 | CSP, CSRF, secure sessions, upload validation, payment secret checks, host validation, request IDs, clean audit, and production placeholder rejection are present. |
| Test/CI readiness | 8.9 / 10 | `verify` covers syntax, lint, the full Node suite, Playwright browser behavior, schema migration, webhooks, payment/provider regressions, uploads, cache headers, backup scripts, health helpers, and audit; coverage thresholds pass. |
| Frontend cleanliness | 8.8 / 10 | Checkout JS is split into state/Stripe/orchestration helpers and browser-tested. Page and responsive CSS use ownership-based import entrypoints. |
| Deployment/operations | 8.8 / 10 | Deploy validates before upload, coverage thresholds run in CI, pre-restart SQLite backup exists, post-restart health checks can send alert webhooks, request IDs and configurable JSON logging are present. External monitoring still must be wired in production. |

## Validation Results

Commands run during the latest cleanup pass:

- `npm run check`: passed, checking 80 Node files, 15 browser modules, and 26 EJS templates.
- `npm run lint`: passed.
- `npm test`: passed, 82/82 tests.
- `npm run coverage:check`: passed at 79.22% line, 62.64% branch, 82.45% functions.
- `npm run verify`: passed.
- `npm audit --audit-level=moderate`: passed with 0 vulnerabilities.
- `npm audit --omit=dev --audit-level=high`: passed with 0 vulnerabilities.
- `npm outdated --depth=0`: passed with no outdated direct dependencies.

## What Is Strong Now

### App Structure

The app startup path is clean and compact. `server.js` is only the runtime entrypoint, `app.js` is a small Express factory, and app composition is split into focused builders.

References:

- `server.js`
- `app.js:10`
- `lib/app-contexts.js:13`
- `lib/app-infrastructure-context.js:32`
- `lib/app-domain-context.js:40`
- `lib/route-contexts.js:1`

### Route Wiring

Route registration is now slim. `lib/app-routes.js` delegates to route modules with prebuilt contexts instead of expanding one giant dependency bag.

References:

- `lib/app-routes.js:8`
- `lib/app-routes.js:12`
- `lib/route-contexts.js:31`
- `routes/admin.js`

### Checkout Flow

Checkout order payload creation is centralized, checkout browser calculations are shared, and the browser checkout code is split into orchestration, form-state, and Stripe modules.

References:

- `lib/checkout-order-service.js`
- `public/scripts/checkout.js`
- `public/scripts/checkout-form-state.js`
- `public/scripts/checkout-stripe.js`
- `public/scripts/checkout-calculations.js`
- `test/checkout-browser.test.js`
- `test/checkout-order-service.test.js`

### Payment And Inventory Lifecycle

Hosted payment orders reserve inventory before the external payment is finalized, release reservations on failed/cancelled/refunded outcomes, avoid double-consuming stock when a reserved order is later marked paid, avoid creating Stripe reserved orders until local Stripe Elements validation succeeds, and reconcile stale external-payment reservations through provider-aware cleanup.

References:

- `lib/order-inventory-service.js`
- `lib/payment-reservation-cleanup-service.js`
- `lib/order-service.js`
- `lib/checkout-order-service.js`
- `routes/public-api.js`
- `routes/webhooks.js`
- `test/db-orders.test.js`
- `test/payment-reservation-cleanup.test.js`
- `test/public-api.test.js`

### Product Repository

Product listing and admin row paths are cleaner. Admin dashboard rows avoid full product hydration, pack reference checks read only bundle JSON, categories use a normalized `product_categories` table for filtering/listing, pack availability filters use hydrated component inventory, and availability pagination refills after post-hydration pack filtering.

References:

- `lib/repositories/products.js:267`
- `lib/repositories/products.js:365`
- `lib/repositories/products.js:379`
- `lib/repositories/products.js:419`
- `lib/db/schema.js`
- `test/products-repository.test.js:90`
- `test/products-repository.test.js:122`

### Documents And Frontend Structure

Order document rendering is split into layout, content, and orchestration modules. Page CSS and responsive CSS are split into ownership files while keeping stable import entrypoints.

References:

- `lib/order-documents.js`
- `lib/order-document-layout.js`
- `lib/order-document-content.js`
- `public/styles/responsive.css`
- `public/styles/catalogue-cards.css`
- `public/styles/checkout-admin.css`
- `public/styles/catalogue-product-cards.css`
- `public/styles/checkout-choice-controls.css`
- `public/styles/responsive-shell.css`
- `public/styles/responsive-catalogue.css`
- `public/styles/responsive-admin-nav.css`
- `test/order-documents.test.js`
- `test/render-smoke.test.js`

### Operations

The app has a JSON health endpoint, a tested health-check script with optional alert webhook delivery, request IDs, configurable logging, a tested SQLite backup helper, a deploy-time pre-restart backup step, stale payment-reservation cleanup, and a thresholded coverage gate.

References:

- `routes/health.js`
- `lib/logger.js`
- `scripts/check-health.js`
- `scripts/backup-sqlite.js`
- `scripts/check-coverage.js`
- `lib/payment-reservation-cleanup-service.js`
- `test/logger.test.js`
- `test/ops-scripts.test.js`
- `test/payment-reservation-cleanup.test.js`

### Quality Gate

The quality gate is genuinely useful:

- Server/browser/template syntax checks.
- ESLint.
- Node test runner.
- Playwright checkout browser tests.
- Direct `checkout-stripe.js` controller unit tests.
- Schema migration tests.
- Product repository performance-shape tests.
- Payment webhook, provider adapter, Stripe intent, mail-service, and stale reservation cleanup tests.
- PDF byte and text-extraction document tests.
- Backup/coverage script tests.
- High-severity dependency audit.
- Deploy workflow runs `npm run verify` and `npm run coverage:check` before upload.

References:

- `package.json`
- `scripts/check-syntax.js`
- `test/`
- `.github/workflows/deploy.yml`

### Security Baseline

The security baseline is strong for a small commerce app:

- `x-powered-by` disabled.
- SQLite-backed sessions.
- `httpOnly`, `sameSite=lax`, `secure=auto` cookies.
- CSRF protection on mutating routes except webhooks.
- CSP with nonced scripts and no `unsafe-inline`.
- HSTS on secure requests.
- Body size limits.
- Image MIME and file-signature validation.
- Production secret requirements with placeholder and short-secret rejection.
- Production admin bootstrap requires an explicit password.

References:

- `lib/http/app-middleware.js`
- `lib/upload-handlers.js`
- `lib/production-secrets.js`
- `lib/config.js`
- `lib/db/schema.js`

### Migration Discipline

Schema migrations now have a table, stable IDs, tests, logging, and README instructions.

References:

- `lib/db/schema.js`
- `test/db-schema-migrations.test.js`
- `README.md`

### Dependency Freshness

Direct dependencies are current according to `npm outdated --depth=0`. The moderate and production high-severity npm audits are clean.

References:

- `package.json`
- `package-lock.json`

## Contextual Future Decisions

### 1. Product Configuration Storage

Product categories are normalized. JSON-backed product options/configurations are still fine for this scale; if catalogue complexity grows substantially, they are the next likely storage area to revisit.

References:

- `lib/repositories/products.js:327`
- `lib/repositories/products.js:382`

Decision:

- Keep current JSON configuration storage until real catalogue size justifies a migration.
- If growth warrants it, add normalized configuration tables.
- Preserve the current admin authoring UX while improving internal query shape.

Expected benefit:

- Less JSON parsing in list paths for option/configuration-heavy catalogues.

### 2. Test Logging Discipline

Tests now opt into quiet logger behavior where they initialize app/database state directly.

Reference:

- `lib/db/schema.js`
- `lib/logger.js`

Maintenance note:

- Keep production migration logs.
- Keep direct route/database tests explicit about logger behavior when adding new files.

Expected benefit:

- Cleaner test output without losing production visibility.

### 3. Upload Coverage Discipline

Invalid upload, validation-failure cleanup, and successful derivative persistence paths are covered through integration behavior.

References:

- `lib/upload-handlers.js`
- `routes/admin-modules/catalog.js`
- `test/app-admin-flows.test.js`

Maintenance note:

- Keep adding targeted upload tests whenever derivative formats or storage rules change.

### 4. Asset Cache Policy Precision

Bundled template assets now use mtime-versioned URLs with immutable cache headers while user uploads stay on conservative cache settings.

Reference:

- `lib/http/app-middleware.js`

Recommended cleanup:

- Keep uploads conservative.
- If a build step is introduced later, replace mtime query strings with hashed filenames.

Expected benefit:

- Better browser caching without risking stale user uploads.

### 5. Production Observability Provider Wiring

The logger now has text/JSON modes, levels, optional compact access logs, request IDs, and structured fallback error context. The deploy path can also run `npm run health:check` after restart and send failed checks to `ALERT_WEBHOOK_URL`. Full production observability would mainly mean connecting JSON logs and that alert webhook to the chosen external monitoring provider.

References:

- `lib/logger.js`
- `lib/http/app-middleware.js`
- `lib/app-routes.js:24`
- `scripts/check-health.js`
- `.github/workflows/deploy.yml`

Operations note:

- Send JSON logs to a production log collector if operations grow.
- Point `ALERT_WEBHOOK_URL` at the chosen incident/chat/uptime relay in production.

Expected benefit:

- Easier debugging under real traffic.

### 6. Package Metadata

The package description now reflects that this is a standalone shop, not just a prototype.

Reference:

- `package.json`

Maintenance note:

- Keep package metadata aligned with any future public naming or deployment changes.

Expected benefit:

- Documentation matches the code’s actual maturity.

## Closed Polish From This Pass

Repo-side polish from the previous pass has been closed:

- Broad `SELECT *` reads were replaced with explicit column lists.
- PDF document tests now extract text and assert core invoice/delivery-slip content.
- `checkout-stripe.js` has direct controller unit coverage with stubbed Stripe/fetch/DOM dependencies.
- README now includes a short architecture note explaining the infrastructure/domain/route context split.
- `.env.example` no longer contains live-looking secrets or production URLs.
- Production config rejects placeholder/short app secrets and copied payment placeholders.
- Stripe checkout validates Stripe Elements before reserving stock.
- Pack availability tests cover hydrated component inventory.
- Paid promo finalization no longer revalidates a promo snapshot after payment.
- Deploy takes a SQLite backup before restart/migration.
- Referer redirects in upload/error paths use safe redirect targets.
- Review submission has a lightweight session rate limit.
- Operational scripts have `require.main === module` guards where they expose helpers.
- Stale Stripe and Swiss Bitcoin Pay reservations are reconciled and release stock when safe.
- Pack availability pagination refills after hydrated filtering.
- Static asset version lookups are cached with a short TTL.
- Stripe intent, Swiss Bitcoin Pay, and mail-service failure paths have targeted unit coverage.
- `eslint` is patch-current.

## External And Conditional Follow-Up

1. Review, stage, and commit the large working-tree change set before treating it as a release candidate.
2. Connect JSON logs and `ALERT_WEBHOOK_URL` to the chosen external monitoring provider.
3. Normalize configuration storage only when catalogue size justifies it.

## Current Verdict

The codebase is now in solid production shape from a code and test standpoint. It should still go through normal release hygiene: review the large diff, ensure every new file is intentionally tracked, and deploy from a clean commit or PR. After that review boundary, the remaining work is operational rather than repository-readiness: production log collection, alert routing, and periodic backup-restore rehearsal.
