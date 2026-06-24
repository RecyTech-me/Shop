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
2. Adjust admin credentials and payment variables
3. Install dependencies with `npm install`
4. Start the app with `npm run dev` or `npm start`

The app listens on `HOST` + `PORT`.

Sessions are stored in the SQLite database, not in memory. Back up `storage/shop.db` before production maintenance or migrations.

## Quality checks

Run the full local quality gate before deploying or merging changes:

```sh
npm run verify
```

This runs:

- `npm run check` for Node/browser/template syntax checks
- `npm run lint`
- `npm test`
- `npm audit --omit=dev --audit-level=high`

For quicker iteration, run individual checks directly:

```sh
npm run check
npm test
```

## Default admin bootstrap

On first start, the app creates the first admin user from:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

When `NODE_ENV=production`, `ADMIN_PASSWORD` is required to bootstrap the first admin. The app also requires these production secrets:

- `SESSION_SECRET`
- `ORDER_VIEW_TOKEN_SECRET`

Use long random values for both. `DATABASE_PATH` can optionally point the app at a non-default SQLite file; otherwise it uses `storage/shop.db`.

## Payment configuration

Stripe:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

Swiss Bitcoin Pay:

- `SWISS_BITCOIN_PAY_API_URL`
- `SWISS_BITCOIN_PAY_API_KEY` (merchant API key from the Swiss Bitcoin Pay dashboard)
- `SWISS_BITCOIN_PAY_WEBHOOK_SECRET` (a long random secret you choose; the app sends it to Swiss Bitcoin Pay in the invoice webhook headers and verifies it on callbacks)

Swiss Bitcoin Pay checkout requires a public `BASE_URL` so the hosted invoice can redirect back to `/checkout/success` and their backend can reach `/webhooks/swiss-bitcoin-pay`. `localhost` is only suitable when testing with a public tunnel.

Buttons stay disabled on the checkout page until the corresponding provider is configured.

## Deployment notes

The GitHub deploy workflow installs production dependencies, runs `npm run verify`, uploads the app, and restarts the service only after validation succeeds. Keep the server `.env` in sync with the production requirements above and keep a database backup routine for `storage/shop.db`.

The app sets security headers, CSRF protection for mutating routes, upload type/size validation, and a Content Security Policy that allows the current local assets and Stripe.js.

## Important routes

- `/`
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
