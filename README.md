# RecyTech Shop Prototype

Standalone Node/Express shop prototype for RecyTech.

## Included

- Public storefront with product list, product page, cart, and checkout
- Admin login with product creation, edition, deletion, and store settings
- SQLite storage for products, settings, orders, and sessions
- Stripe Checkout session creation
- Swiss Bitcoin Pay invoice creation
- Stripe and Swiss Bitcoin Pay webhook endpoints

## Quick start

1. Copy `.env.example` to `.env`
2. Adjust admin credentials and payment variables
3. Install dependencies with `npm install`
4. Start the app with `npm run dev` or `npm start`

The app listens on `HOST` + `PORT`.

Sessions are stored in the SQLite database, not in memory. Back up `storage/shop.db` before production maintenance or migrations.

## Default admin bootstrap

On first start, the app creates the first admin user from:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

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

## Important routes

- `/`
- `/cart`
- `/checkout`
- `/admin/login`
- `/admin`
- `/webhooks/stripe`
- `/webhooks/swiss-bitcoin-pay`
