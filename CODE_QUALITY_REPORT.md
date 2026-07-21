# Codebase Audit Report

Date: 2026-07-21

Audit target: `dev` at `1fcefcd`, including the current hardening working tree.

## 1. Executive summary

This is a well-structured small Express/EJS commerce application, not a prototype. The repository has clear composition layers, focused repositories and domain services, SQLite migrations, provider-aware payment flows, strong security defaults, broad automated tests, operational scripts, and useful documentation.

The audit initially reproduced four serious integrity failures: a delayed payment event could regress a fulfilled order, hard-deleting an externally reserved order leaked stock and removed the provider reconciliation target, a removed promo code could block payment finalization, and imported products bypassed normalized price/category data. Those defects are fixed and covered by regression tests. Subsequent adversarial passes also found and fixed a checkout draft/submission race, shutdown ordering that could close SQLite under an in-flight cleanup task, deletion or topology changes for products still reserved by active orders, incomplete backup identity checks, and weak validation at payment-provider boundaries. The final passes additionally corrected unknown Swiss Bitcoin Pay creation outcomes, webhook recovery after a provider-reference persistence crash, premature stock release after a retryable Stripe failure, synchronous password hashing on the public login path, and unsafe production HTTP/SMTP/provider transports.

The remaining risks are operational and scale-related rather than repository fixes: production monitoring and branch protection must be configured outside the repository, restore/deployment rollback must be drilled on the target infrastructure, and JSON-backed product configurations may eventually become expensive if the catalogue becomes much larger.

| Category             | Rating | Comment |
| -------------------- | -----: | ------- |
| Architecture         | 8.9/10 | Clean infrastructure/domain/route composition; order status still combines payment and fulfillment concepts. |
| Code quality         | 9.1/10 | Readable, consistent, and mostly focused; a few route and normalization modules remain large. |
| Optimization         | 8.8/10 | Indexed catalogue paths, pagination, caching, derivatives, and shared pack hydration are appropriate for current scale. |
| Reliability          | 9.3/10 | Payment, inventory, promo, import, timeout, crash-window, shutdown, and background-task failure modes are guarded and tested. |
| Security             | 9.4/10 | Strong headers, CSRF, sessions, async rate-limited login, transport/boundary validation, secret checks, file permissions, pinned CI actions, and verified deployment hosts. |
| Tests                | 9.3/10 | 245 tests cover browser, integration, migration, payment, security, operations, and regressions; the current sandbox cannot rerun 17 listener-backed tests. |
| Developer experience | 9.3/10 | Clear scripts/docs, reproducible install, strict checks, explicit browser setup, CI, Dependabot, and operational runbooks. |
| Production readiness | 8.9/10 | Staged rollback-capable deployment, backups, health checks, structured logs, and graceful shutdown; external monitoring and infrastructure drills remain. |

Overall rating: **9.2/10**.

## 2. What I inspected

Repository areas inspected:

- Root entry points and metadata: `app.js`, `server.js`, `package.json`, `package-lock.json`, `.gitignore`, `.env.example`, and README/documentation.
- Application composition: `lib/app-contexts.js`, `lib/app-infrastructure-context.js`, `lib/app-domain-context.js`, `lib/route-contexts.js`, and `lib/app-routes.js`.
- Database/schema/repositories: `lib/db.js`, `lib/db/schema.js`, and all files under `lib/repositories/`.
- Checkout, orders, payments, inventory, promo codes, mail, uploads, auth, sessions, validation, logging, and background cleanup services under `lib/`.
- Public/admin route modules under `routes/`, EJS templates under `views/`, and checkout browser modules/assets under `public/`.
- Operational/import scripts under `scripts/`.
- The complete `test/` suite, including Node integration tests and Playwright browser tests.
- CI/CD definitions in `.github/workflows/ci.yml` and `.github/workflows/deploy.yml`.
- Architecture, operations, and release documentation under `docs/`.

Commands and tools used:

- `rg`, `find`, `git status`, `git diff`, `git diff --check`, `git check-ignore`, and tracked-file secret-pattern checks.
- `npm run check`, `npm run lint`, `npm test`, `npm run verify`, `npm run coverage:check`, and focused/non-listening Node test runs.
- `npm audit --audit-level=moderate`, the production-only high audit in `npm run verify`, `npm outdated --long`, and `npm ls --all`.
- `npm ci --dry-run --ignore-scripts` to verify lockfile/install consistency.
- Focused Node test runs while changing payment, order, import, upload, mail, product, and operational code.
- Ruby's YAML parser for both GitHub Actions workflow files.
- File mode inspection for `.env`, SQLite databases, WAL/SHM files, importer reports, and backups.

Validation results:

- Syntax: 87 Node files, 15 browser modules, and 26 EJS templates passed.
- ESLint: passed.
- Tests: the last unrestricted complete gate passed 227/227 with 0 skipped. The final tree defines 245 tests; all 228 tests outside the five local-listener/browser files pass. The current sandbox rejects loopback listeners with `EPERM`, so the final 17 listener-backed tests could not be rerun after the last incremental fixes.
- Coverage: the last complete measurement was 88.44% lines, 72.51% branches, and 88.66% functions; all configured thresholds passed. A final complete measurement is subject to the same listener restriction.
- Dependency audit: the last network-enabled audit reported 0 known vulnerabilities after repairing the lockfile. The final retry was blocked by registry DNS/network restrictions; dependency declarations did not change afterward.
- Dependency tree and clean-install dry run: passed.
- Workflow YAML and whitespace checks: passed.

## 3. Main strengths

- `server.js` and `app.js` are small entry points; infrastructure, domain services, route contexts, and repositories have clear ownership.
- Cross-row commerce rules live in services rather than route handlers. Inventory reservation/consumption/release and provider reconciliation are transaction-aware.
- SQLite has named idempotent migrations, foreign keys, WAL mode, query indexes, normalized product categories, and tested old-schema upgrades.
- The checkout protects provider operations with CSRF, rate limiting, session-bound Stripe drafts, signed order-view tokens, verified webhooks, and production secret/HTTPS validation.
- Payment mutations are idempotent at the domain boundary. A recorded payment cannot be regressed by delayed failure/pending events, and duplicate success does not consume stock or promo use twice.
- Product listing does SQL-side price/category filtering and pagination. Pack hydration now shares component lookups across a listing instead of issuing duplicate queries.
- Uploads have size/type/signature validation, derivatives, error cleanup, and CSRF-rejection cleanup.
- Security headers are strong: nonced CSP without `unsafe-inline`, HSTS on secure requests, frame/type/referrer/permissions controls, secure session settings, host validation, and body limits.
- Production operations include structured logging, request IDs, health/readiness checks, graceful shutdown, provider-aware stale reservation cleanup, online SQLite backups, backup verification, and documented restore procedures.
- Graceful shutdown waits for in-flight reservation cleanup before closing SQLite, and reports cleanup failure through the process exit status instead of silently succeeding.
- Retryable Stripe payment failures keep their stock reservation; only terminal cancellation releases it. Unknown Swiss Bitcoin Pay invoice outcomes also retain stock, and authenticated callbacks can recover a missing reference from the embedded order number.
- Public login password verification uses asynchronous scrypt and counts attempts before the hash work, preventing the login path from blocking the Node event loop or admitting same-source bursts past the limiter.
- Checkout draft writes are serialized with final native and Stripe submissions, preventing a late autosave from restoring stale cart or idempotency state after an order is submitted.
- Backup verification checks both SQLite integrity and the application schema identity; a valid but unrelated database is rejected.
- The test suite covers browser behavior, real SQLite transactions, migrations, payment/provider edge cases, admin/storefront routes, PDFs, uploads, security, importer rollback/idempotency, scripts, and shutdown behavior.
- CI installs the required browser runtime and runs verification, coverage, audit, and secret scanning. Deployment is serialized, staged, backed up, host-key pinned, restarted, and health checked.

## 4. Critical issues

No unresolved Critical or High-severity code defects remain from this audit. The important issues below were reproduced before remediation and are now fixed in the working tree.

### Delayed payment events could corrupt paid order state

* **Severity:** High
* **Category:** Reliability
* **Location:** `lib/order-service.js:17`, `lib/db.js:174`, `lib/order-update-service.js:47`, `lib/repositories/dashboard.js:19`
* **Problem:** Duplicate success events could reset shipped/completed orders to `paid`; later failed/cancelled provider events could regress a paid order; direct fulfillment transitions could bypass inventory consumption; fulfilled revenue was excluded from dashboard totals.
* **Why it matters:** Provider webhooks are retried and may arrive out of order. The old behavior could misstate fulfillment, revenue, and stock after a valid payment.
* **Recommendation:** Implemented: central paid-status semantics, immutable recorded-payment state for external updates, idempotent paid finalization, inventory-aware fulfillment transitions, and fulfilled-order revenue accounting.
* **Estimated effort:** Medium
* **Risk of change:** Medium

### Reserved external orders could be hard deleted

* **Severity:** High
* **Category:** Reliability
* **Location:** `lib/db.js:191`, `lib/db.js:210`, `routes/admin-modules/orders.js:244`
* **Problem:** Admin deletion removed an order row without releasing reserved stock or preserving the provider reference.
* **Why it matters:** Stock remained permanently reduced, while a later provider success had no local order to reconcile. It also removed payment/audit evidence.
* **Recommendation:** Implemented: hard deletion is rejected for any order with external payment references, inventory history, recorded payment, fulfillment state, or refund history. Safe unpaid local orders remain deletable, and active promo reservations are released transactionally.
* **Estimated effort:** Small
* **Risk of change:** Low

### Promo limits and payment finalization were not transactionally safe

* **Severity:** High
* **Category:** Reliability
* **Location:** `lib/db.js:85`, `lib/db.js:118`, `lib/order-service.js:17`
* **Problem:** Promo usage was incremented only after payment, allowing concurrent pending checkouts to claim the final allowed use. Deleting the promo record before provider success caused paid finalization to throw and roll back.
* **Why it matters:** Limited promotions could be oversubscribed, and an already captured payment could remain locally pending with unfinalized inventory.
* **Recommendation:** Implemented: promo use is atomically reserved in the order-creation transaction, released for unpaid failures/cancellations/deletions, converted to redeemed at payment, and treated as a non-blocking warning if the promo record was removed after acceptance.
* **Estimated effort:** Medium
* **Risk of change:** Medium

### WordPress imports bypassed catalogue invariants and exposed generated credentials

* **Severity:** High
* **Category:** Reliability / Security
* **Location:** `scripts/import-wordpress-shop.js:90`, `scripts/import-wordpress-shop.js:250`, `scripts/import-wordpress-shop.js:452`
* **Problem:** Imported products did not populate derived price ranges or normalized categories, so filters could omit them. Generated temporary admin passwords were included in normal stdout output.
* **Why it matters:** The imported catalogue behaved inconsistently, and CI/shell logs could retain administrator credentials.
* **Recommendation:** Implemented: importer writes reuse canonical price/category helpers inside the transaction; administrator imports require an explicit report; reports are mode `0600`; stdout exposes only a credential count.
* **Estimated effort:** Medium
* **Risk of change:** Low

### Deployment could be interrupted or trust an unverified SSH host

* **Severity:** High
* **Category:** DX / Security
* **Location:** `.github/workflows/deploy.yml`
* **Problem:** A newer push could cancel an in-progress in-place deployment, and the workflow trusted the host key obtained over the same network connection.
* **Why it matters:** Cancellation could leave a partially synchronized application, while dynamic key discovery did not protect against a man-in-the-middle during deployment.
* **Recommendation:** Implemented: production deployments are serialized without mid-flight cancellation, build/install occurs in a staging directory, promotion preserves runtime data, and SSH host keys must come from the trusted `DEPLOY_KNOWN_HOSTS` secret.
* **Estimated effort:** Medium
* **Risk of change:** Medium

### Ambiguous or retryable provider outcomes could release stock prematurely

* **Severity:** High
* **Category:** Reliability
* **Location:** `routes/checkout.js`, `routes/webhooks.js`, `lib/payment-reservation-cleanup-service.js`
* **Problem:** Swiss Bitcoin Pay creation failures were all treated as definitive, cleanup released reservations with no provider reference, and a retryable Stripe `payment_intent.payment_failed` event marked the order failed.
* **Why it matters:** A provider may have accepted a timed-out request, and a failed Stripe attempt can be retried on the same PaymentIntent. Releasing stock in either case permits another order to consume inventory that may already be payable or paid.
* **Recommendation:** Implemented: unknown outcomes retain reservations, only definitive rejections/cancellations release them, authenticated SBP callbacks can recover missing invoice references, and missing-reference cleanup requires operator/provider confirmation.
* **Estimated effort:** Medium
* **Risk of change:** Medium

### Production transports could expose credentials and customer data

* **Severity:** High
* **Category:** Security
* **Location:** `lib/config.js`, `lib/mail-service.js`
* **Problem:** Production without an enabled payment provider accepted a plain-HTTP canonical origin, custom SBP API URLs could use HTTP, and SMTP port 587 did not require a STARTTLS upgrade.
* **Why it matters:** A configuration mistake could expose admin credentials, session cookies, the merchant API key, SMTP credentials, or customer/order data in transit.
* **Recommendation:** Implemented: production now requires a public HTTPS origin, configured SBP endpoints require HTTPS without embedded credentials, and non-implicit-TLS production SMTP requires STARTTLS.
* **Estimated effort:** Small
* **Risk of change:** Low

## 5. Optimization opportunities

### High-impact optimizations

No additional high-impact optimization is justified for the current application size. The audit did not find a realistic CPU, memory, network, or database bottleneck requiring immediate work.

The concrete N+1 found during the audit was fixed: `lib/repositories/products.js:358` now shares a hydration cache across listed packs, and `lib/product-normalizers.js:220` reuses cached components before querying SQLite. A regression test proves two packs sharing one component perform one component lookup.

### Medium-impact optimizations

- Normalize product configurations only if catalogue size or filter complexity grows materially. Availability for packs still requires post-query hydration because bundle composition and option inventory are JSON-backed. Expected benefit at larger scale: predictable SQL filtering and fewer JSON parses. Current benefit would be small relative to migration complexity.
- If order volume grows, split `payment_status` and `fulfillment_status` into indexed columns. Expected benefit: simpler queries, clearer transitions, and less metadata/status interpretation. At current volume, the centralized invariant is adequate.

### Low-impact or optional optimizations

- Add a build-time asset fingerprinting pipeline only if frontend assets become numerous. The current mtime-versioned immutable URLs already avoid stale bundled assets without build complexity.
- Consider a short-lived cache for category/admin dashboard aggregates only after profiling shows repeated SQLite reads are meaningful. SQLite queries are currently small and indexed; caching now would add invalidation risk for little gain.

## 6. Code cleanup opportunities

The final pass found no cleanup whose present benefit clearly exceeds its migration or regression risk. The following are conditional design triggers, not current defects or recommended pre-release work:

- Split payment and fulfillment status only if future workflows require independent state queries or transitions; the current centralized invariant is correct and tested.
- Normalize JSON product configurations only if measured catalogue size makes hydration or filtering material.
- Introduce a promo-redemption ledger only if promotion reporting or rule complexity outgrows the current transactional counters.
- Split route modules when new responsibilities make their current boundaries difficult to navigate; doing so now would be cosmetic churn.

## 7. Test improvements

No high-value locally executable regression test remains missing under the audited behavior. The suite covers domain transactions against real SQLite databases, route integration, migration compatibility, browser checkout behavior, scripts, shutdown, security controls, and provider failure/order permutations.

Live Stripe and Swiss Bitcoin Pay contracts, SMTP delivery, remote SSH deployment, and off-host restore drills require protected credentials or infrastructure. Those checks belong in protected staging or scheduled operational jobs; adding credential-dependent pull-request tests would be unreliable and unsafe.

## 8. Security and dependency notes

- The most recent network-enabled moderate and production-only high-severity audits both reported **0 vulnerabilities**. The final retry could not reach the npm registry from the restricted sandbox.
- A high-severity transitive `brace-expansion` development vulnerability was found and fixed in `package-lock.json`.
- Safe compatible updates were installed for ESLint 10.7.0, Nodemailer 9.0.3, Sharp 0.35.3, and Stripe 22.3.2.
- `better-sqlite3` 13.0.1 is a new major version; the project remains on the current 12.11.1 range intentionally until its breaking changes and native deployment compatibility are reviewed.
- `.env` and `storage/*.db` are ignored. No tracked live Stripe/webhook/private-key pattern was found; matches were validation code and fake test data. CI still performs the authoritative Gitleaks scan.
- The local `.env`, SQLite database, WAL/SHM files, generated importer credential report, and backup output are owner-only (`0600`). Database initialization enforces permissions for future database/sidecar creation.
- External Swiss Bitcoin Pay, SMTP, health, and alert calls now have timeouts. Provider error bodies are whitespace-normalized and truncated before logging/throwing.
- Production requires a public HTTPS canonical origin, custom Swiss Bitcoin Pay endpoints must use HTTPS without embedded credentials, and non-implicit-TLS SMTP requires STARTTLS.
- New/changed admin passwords require 12–128 characters on both server and form. Production bootstrap secrets retain stricter startup validation.
- Production deployment now requires a pre-verified `DEPLOY_KNOWN_HOSTS` value. This is a required configuration change before the next deployment.
- External monitoring, branch protection, secret rotation, firewall/reverse-proxy policy, and off-host backup retention remain deployment responsibilities and cannot be proven from the repository alone.

## 9. Recommended action plan

### Phase 1 — Quick wins

Completed in this pass:

- Fixed order/payment state regression, fulfillment inventory handling, dashboard revenue, and unsafe hard deletion.
- Added atomic promo reservation/release/finalization.
- Fixed importer catalogue invariants and credential output handling.
- Added strict product, checkout, and admin password validation.
- Added outbound timeouts, background cleanup single-flight behavior, upload cleanup, and owner-only data-file permissions.
- Repaired the dependency vulnerability and applied compatible package updates.
- Installed browser dependencies explicitly in CI and documented local setup.

### Phase 2 — Structural cleanup

No structural change is justified before release. Reconsider the following only if their stated trigger occurs:

- Split order payment and fulfillment state if future workflows need independent transitions or indexed queries.
- Add a promo-redemption ledger if reporting or promotion-rule complexity grows.
- Normalize product configurations if measured catalogue growth makes JSON hydration material.
- Split route modules if added responsibilities make the current boundaries difficult to navigate.

### Phase 3 — Hardening

- Configure `DEPLOY_KNOWN_HOSTS`, branch protection, production JSON log forwarding, external uptime monitoring, and `ALERT_WEBHOOK_URL`.
- Run and record an off-host backup restore drill before launch and periodically afterward.
- Run protected staging smoke checks against the real payment-provider and SMTP sandboxes.
- Rehearse automatic code rollback and manual database restore on the target host; additive database migrations intentionally are not reversed automatically.
- Review the `better-sqlite3` 13 migration in an isolated branch with native build/deploy validation.

## 10. Final recommendation

The codebase is **clean and ready as a production candidate**, subject to the documented external operational settings and a restore/rollback drill on the real target infrastructure.

It is not appropriate to call it proven in production from repository evidence alone because monitoring, branch protection, deploy secrets, provider credentials, off-host backup retention, and infrastructure behavior are external controls. The completed audit found no remaining actionable repository fix under the available evidence and environment; that is not a claim that the software contains no defects.
