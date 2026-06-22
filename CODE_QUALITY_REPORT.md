# RecyTech Shop Code Quality Audit

Date: 2026-06-22

## Executive Summary

The project is a solid, compact Express/EJS shop with good baseline security habits and clear domain intent. It is already more careful than a quick prototype: SQL is parameterized, sessions are stored in SQLite, CSRF protection exists, user-facing template output is mostly escaped, uploaded images are validated by file signature, and the existing syntax check passes.

The main cleanup opportunity is architectural rather than cosmetic. The app has grown from a prototype into a small production system, but much of the application composition, validation glue, payment setup, route dependency wiring, and helper logic still flows through `server.js`. The code can become much cleaner by separating infrastructure, repositories, domain services, and route handlers, then adding automated tests and dependency/security gates.

Overall cleanliness/readiness rating: 7.0 / 10

## Ratings

| Area | Rating | Notes |
| --- | ---: | --- |
| Readability | 7.0 / 10 | Naming is mostly clear and code is understandable, but several files are too broad. |
| Maintainability | 6.4 / 10 | Large dependency objects and mixed responsibilities make future changes harder than necessary. |
| Optimization | 6.8 / 10 | Fine for a small catalog, but product/order queries hydrate and filter too much in memory. |
| Security readiness | 6.5 / 10 | Good app-level basics, weakened by vulnerable installed dependencies and soft secret defaults. |
| Test/CI readiness | 4.5 / 10 | Syntax checks exist, but no automated unit/integration/security gate runs before deploy. |
| Frontend cleanliness | 7.2 / 10 | Scripts are modular and progressive, with some duplicated parsing logic. |
| Deployment/operations | 6.2 / 10 | Deploy workflow is simple, but it deploys without running checks first. |

## What Is Working Well

- `npm run check` passes: 20 Node files, 10 browser modules, and 26 EJS templates compile cleanly.
- `server.js` disables `x-powered-by`, sets core security headers, uses session cookies with `httpOnly`, `sameSite=lax`, and `secure=auto`, and protects mutating routes with CSRF checks.
- SQLite access generally uses prepared statements and bound values.
- EJS templates mostly use escaped output. Unescaped EJS is used mainly for includes and JSON-LD with `<` escaping.
- Upload handling checks both MIME allowlist and stored image signatures before accepting files.
- Checkout, cart, product configuration, and admin flows show careful domain validation and useful error messages.
- Static assets are modest: about 176 KB images, 168 KB fonts, 72 KB CSS, and 88 KB JS.

## Priority 0: Fix Before Calling This Production-Clean

### 1. Update vulnerable dependencies

`npm audit --omit=dev --json` reports 5 production vulnerabilities: 2 high and 3 moderate.

Affected direct dependencies:

- `multer`: current installed version is `2.1.1`; advisories include DoS issues fixed by `2.2.0`.
- `nodemailer`: current installed version is `8.0.5`; audit reports advisories fixed after the currently installed line.
- `express` / transitive `body-parser` / `qs`: moderate advisory fixed by newer patch versions.

References:

- `package.json:12-20`

Recommended cleanup:

- Update patch/minor-safe dependencies first: `express`, `multer`, and `nodemailer`.
- Re-run `npm audit --omit=dev`.
- Re-run `npm run check`.
- Smoke test admin upload, SMTP send, checkout, and webhook endpoints after the update.

### 2. Add validation before deployment

The deploy workflow uploads files and restarts the service without running the local syntax check or dependency audit.

Reference:

- `.github/workflows/deploy.yml:29-50`

Recommended cleanup:

- Add a pre-deploy validation step before `rsync`:
  - `npm ci`
  - `npm run check`
  - `npm audit --omit=dev --audit-level=high`
- Optionally split deploy into `check` and `deploy` jobs so production deploy depends on a clean check job.

### 3. Fail fast on missing production secrets

If `SESSION_SECRET` is missing, the app generates a random secret at process start. That avoids immediate failure, but it invalidates sessions on restart and can hide a bad production configuration.

References:

- `server.js:95`
- `server.js:1021`
- `.env.example`

Recommended cleanup:

- In production, require `SESSION_SECRET`.
- In production, require `ORDER_VIEW_TOKEN_SECRET` instead of silently falling back to `SESSION_SECRET`.
- On first admin bootstrap, require `ADMIN_PASSWORD` in production instead of logging a generated password.

## Priority 1: Architecture And Maintainability

### 4. Split `server.js` into smaller composition modules

`server.js` is 1,282 lines and currently owns environment setup, app setup, database initialization, payment services, rate limiting, CSRF, view locals, helper functions, route registration, and server startup.

References:

- `server.js:82-111`
- `server.js:1016-1060`
- `server.js:1180-1260`

Recommended cleanup:

- Create an `app.js` or `lib/create-app.js` that builds and returns the Express app.
- Move environment parsing into `lib/config.js`.
- Move payment provider setup into `lib/payments/`.
- Move auth/session/CSRF middleware into `lib/http/` or `middleware/`.
- Keep `server.js` as the thin entrypoint: load config, create app, listen.

Expected result:

- Easier tests without binding a real port.
- Smaller route registration signatures.
- Less risk when changing payment, session, or admin behavior.

### 5. Replace wide dependency bags with focused contexts

`registerAdminRoutes` destructures roughly 80 dependencies. This makes route code explicit, but it is now too wide to reason about easily.

References:

- `routes/admin.js:10-90`
- `server.js:1180-1260`

Recommended cleanup:

- Group dependencies into contexts:
  - `repos.products`, `repos.orders`, `repos.admins`
  - `services.checkout`, `services.mail`, `services.uploads`, `services.documents`
  - `http.requireAdmin`, `http.render`, `http.flash`
- Keep route modules focused on HTTP concerns and call named services for domain work.

### 6. Split `lib/db.js` by responsibility

`lib/db.js` is 1,318 lines and mixes schema creation, seed data, migrations, product repositories, admin repositories, review/promo repositories, dashboard aggregation, order creation, and order payment transactions.

References:

- `lib/db.js:60-189`
- `lib/db.js:441-560`
- `lib/db.js:877-906`
- `lib/db.js:1090-1264`

Recommended cleanup:

- Move schema/bootstrap into `lib/db/schema.js`.
- Move query groups into `lib/repositories/products.js`, `orders.js`, `admins.js`, `reviews.js`, `promo-codes.js`, `settings.js`.
- Move `markOrderPaid` inventory/promo mutation into an `order-service` module with tests.
- Keep `lib/db.js` as connection/bootstrap only, or remove it after migration.

### 7. Add focused tests for high-risk domain logic

There are no automated unit/integration tests beyond syntax/template compilation.

Highest-value test targets:

- Product option parsing and strict validation in `lib/product-normalizers.js`.
- Cart quantity and service tag validation in `lib/cart-session.js`.
- Checkout pricing, promo codes, delivery rules, and payment method rules in `lib/checkout-state.js`.
- `markOrderPaid` inventory reduction and promo redemption in `lib/db.js`.
- Webhook idempotency and state transitions in `routes/webhooks.js`.
- PDF document generation smoke tests in `lib/order-documents.js`.

Recommended cleanup:

- Use Node's built-in `node:test` runner to avoid adding a large test framework.
- Add a `test` script and run it in CI/deploy before upload.

## Priority 2: Optimization And Scaling

### 8. Push more product filtering into SQL

`listPublishedProducts` selects and hydrates all published products, then filters category, availability, and price in JavaScript. It also supports `ORDER BY RANDOM()`, which is fine for a tiny catalog but expensive as data grows.

Reference:

- `lib/db.js:441-504`

Recommended cleanup:

- Add indexes for common filters/sorts: `products(published, featured, created_at)`, `products(published, product_kind)`, and order-related indexes.
- Push availability and simple price filters into SQL where possible.
- Consider storing searchable/lowercase category fields or a normalized category join table if categories become important for performance.
- Avoid `ORDER BY RANDOM()` on large product sets; use a lightweight seed/order strategy or limit candidate rows first.

### 9. Avoid repeated full hydration for dashboard and locals

The app currently builds settings and cart locals on every handled request, and dashboard stats hydrate all admin products to compute potential revenue.

References:

- `server.js:1049-1051`
- `lib/db.js:877-906`

Recommended cleanup:

- Cache settings in memory and invalidate after `saveSettings`.
- Build cart locals only for routes/templates that need them, or lazy-compute it.
- For dashboard stats, use SQL aggregates where possible and isolate expensive inventory projections behind a dedicated function.

### 10. Bound in-memory rate-limit trackers

Login and Stripe intent attempt tracking use process-local `Map` instances. Entries are deleted when a key is checked after expiry, but there is no global pruning or size cap.

References:

- `server.js:96-97`
- `server.js:465-565`

Recommended cleanup:

- Add scheduled pruning and a maximum map size.
- Or move to a small reusable TTL map helper.
- If multi-process deployment is planned, use a shared store instead of process-local maps.

### 11. Add static asset cache policy

Static files are served without explicit cache options.

Reference:

- `server.js:111`

Recommended cleanup:

- Add a conservative cache policy for immutable assets if filenames are versioned.
- At minimum, define explicit behavior for `/static/uploads` versus bundled CSS/JS/images.

## Priority 3: Frontend And Template Cleanliness

### 12. Deduplicate configuration parsing in browser scripts

`product-configurator.js` and `manual-order-form.js` parse configuration JSON, normalize selections, compute compatibility, and find complete configurations in similar ways.

References:

- `public/scripts/product-configurator.js:19-95`
- `public/scripts/manual-order-form.js:20-96`

Recommended cleanup:

- Extract shared helpers into a browser module such as `public/scripts/configurations.js`.
- Reuse a single `parseConfigurations`, `getSelections`, `isConfigurationCompatible`, and `findCompleteConfiguration`.

### 13. Replace manual `innerHTML` option building with DOM helpers

The manual order form carefully escapes option values, but the escaping is inline and duplicated.

Reference:

- `public/scripts/manual-order-form.js:226-228`

Recommended cleanup:

- Build `<option>` elements with `document.createElement("option")` and `textContent`.
- Or centralize escaping in one helper if string templates are kept.

### 14. Move SEO metadata out of the `head` partial

`views/partials/head.ejs` hard-codes `https://shop.recytech.me` even though the server already has URL helpers and sets `res.locals.canonicalUrl`.

References:

- `views/partials/head.ejs:6-18`
- `views/partials/head.ejs:46-66`
- `server.js:1055-1056`

Recommended cleanup:

- Compute canonical URL, image URL, and structured-data URLs in a server-side presenter.
- Pass final metadata into the template instead of calculating it inside `head.ejs`.

### 15. Clean CSS ownership and design tokens

CSS is split, but file ownership is blurred. `footer-responsive.css` is much broader than footer/responsive rules. Also, `--bg: red` looks like leftover development state.

References:

- `public/styles/base-layout.css:7`
- `public/styles/main.css:1-5`

Recommended cleanup:

- Rename/split CSS files by ownership: base, header/nav, hero/catalogue, product, forms/checkout, admin, footer, responsive.
- Remove unused tokens.
- Centralize repeated semantic colors such as success/error/info.

## Priority 4: Specialized Risk Areas

### 16. Add tests or visual snapshots for PDF generation

`lib/order-documents.js` hand-builds PDF bytes, text encoding, drawing commands, SVG parsing, pagination, and document layout. This is impressive and dependency-light, but easy to regress.

References:

- `lib/order-documents.js:1-120`

Recommended cleanup:

- Add smoke tests that generate invoice and delivery slip PDFs from representative orders.
- Validate that the output starts with `%PDF`, includes expected page count, and does not throw on accented French text.
- For higher confidence, render sample PDFs in CI and compare basic text extraction or page dimensions.

### 17. Add linting and formatting

The code has consistent indentation, but there is no lint or format gate.

Recommended cleanup:

- Add ESLint for Node/browser globals and basic correctness rules.
- Add Prettier or an agreed formatting command.
- Add scripts:
  - `lint`
  - `format:check`
  - `test`
  - `verify` running check + lint + test

## Suggested Cleanup Order

1. Update dependencies and clear the audit.
2. Add CI/deploy validation using the existing `npm run check`.
3. Add production config assertions for secrets.
4. Add tests for checkout pricing, product parsing, and `markOrderPaid`.
5. Split `server.js` into config/app/middleware/services.
6. Split `lib/db.js` into schema/repositories/order service.
7. Optimize product listing and dashboard queries.
8. Deduplicate frontend configuration helpers.
9. Clean CSS ownership and remove dead tokens.
10. Add PDF smoke tests.

## Validation Run During Audit

- `npm run check`: passed.
- `npm audit --omit=dev --json`: failed due to 5 production advisories.
- `npm outdated --json`: reported available updates for `better-sqlite3`, `dotenv`, `ejs`, `express`, `multer`, `nodemailer`, and `stripe`.
- Git working tree was clean before this report file was added.

