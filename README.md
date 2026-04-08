# RecyTech Shop Prototype

Standalone Node/Express shop prototype for RecyTech.

## Included

- Public storefront with product list, product page, cart, and checkout
- Admin login with product creation, edition, deletion, and store settings
- SQLite storage for products, settings, and orders
- Stripe Checkout session creation
- BTCPay invoice creation
- Stripe and BTCPay webhook endpoints

## Quick start

1. Copy `.env.example` to `.env`
2. Adjust admin credentials and payment variables
3. Install dependencies with `npm install`
4. Start the app with `npm run dev` or `npm start`

The app listens on `HOST` + `PORT`.

## Default admin bootstrap

On first start, the app creates the first admin user from:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

## Payment configuration

Stripe:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

BTCPay:

- `BTCPAY_SERVER_URL`
- `BTCPAY_STORE_ID`
- `BTCPAY_API_KEY`
- `BTCPAY_WEBHOOK_SECRET`

Buttons stay disabled on the checkout page until the corresponding provider is configured.

## Important routes

- `/`
- `/cart`
- `/checkout`
- `/admin/login`
- `/admin`
- `/webhooks/stripe`
- `/webhooks/btcpay`
