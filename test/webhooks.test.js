const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");
const logger = require("../lib/logger");
const { registerWebhookRoutes } = require("../routes/webhooks");

logger.configureLogger({ level: "silent" });

function listen(app, t) {
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise((resolve) => server.close(resolve)));

    return new Promise((resolve) => {
        server.once("listening", () => {
            const { port } = server.address();
            resolve(`http://127.0.0.1:${port}`);
        });
    });
}

function registerTestWebhookRoutes({
    app,
    stripe = null,
    env = {},
    getOrderByProviderReference,
    getOrderByNumber = () => null,
    updateOrderProviderReference = () => null,
    markOrderPaid,
    updateOrderStatus,
    verifySwissBitcoinPayWebhook = () => true,
    mapSwissBitcoinPayStatus = () => "pending",
}) {
    registerWebhookRoutes({
        app,
        db: {},
        providers: { stripe, stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET },
        repositories: {
            getOrderByProviderReference,
            getOrderByNumber,
            updateOrderProviderReference,
            markOrderPaid,
            updateOrderStatus,
        },
        payments: {
            verifySwissBitcoinPayWebhook,
            mapSwissBitcoinPayStatus,
        },
        text: {
            normalizeText: (value) => String(value || "").trim(),
        },
    });
}

test("stripe webhook marks successful payment intents paid", async (t) => {
    const app = express();
    const calls = [];

    registerTestWebhookRoutes({
        app,
        stripe: {
            webhooks: {
                constructEvent: () => ({
                    type: "payment_intent.succeeded",
                    data: { object: { id: "pi_test", status: "succeeded" } },
                }),
            },
        },
        env: { STRIPE_WEBHOOK_SECRET: "secret" },
        getOrderByProviderReference: (db, provider, reference) =>
            provider === "stripe" && reference === "pi_test" ? { id: 10 } : null,
        markOrderPaid: (db, orderId, metadata) => calls.push(["paid", orderId, metadata]),
        updateOrderStatus: (db, orderId, status, metadata) => calls.push(["status", orderId, status, metadata]),
    });

    const baseUrl = await listen(app, t);
    const response = await fetch(`${baseUrl}/webhooks/stripe`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "stripe-signature": "test",
        },
        body: JSON.stringify({}),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(calls, [["paid", 10, {
        stripePaymentIntentId: "pi_test",
        paymentStatus: "succeeded",
    }]]);
});

test("stripe webhook keeps failed attempts pending so the PaymentIntent can be retried", async (t) => {
    const app = express();
    const calls = [];

    registerTestWebhookRoutes({
        app,
        stripe: {
            webhooks: {
                constructEvent: () => ({
                    type: "payment_intent.payment_failed",
                    data: { object: { id: "pi_failed", status: "requires_payment_method" } },
                }),
            },
        },
        env: { STRIPE_WEBHOOK_SECRET: "secret" },
        getOrderByProviderReference: (db, provider, reference) =>
            provider === "stripe" && reference === "pi_failed" ? { id: 11 } : null,
        markOrderPaid: (db, orderId, metadata) => calls.push(["paid", orderId, metadata]),
        updateOrderStatus: (db, orderId, status, metadata) => calls.push(["status", orderId, status, metadata]),
    });

    const baseUrl = await listen(app, t);
    const response = await fetch(`${baseUrl}/webhooks/stripe`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "stripe-signature": "test",
        },
        body: JSON.stringify({}),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [["status", 11, "pending", {
        stripePaymentIntentId: "pi_failed",
        paymentStatus: "requires_payment_method",
    }]]);
});

test("stripe webhook marks canceled payment intents failed", async (t) => {
    const app = express();
    const calls = [];

    registerTestWebhookRoutes({
        app,
        stripe: {
            webhooks: {
                constructEvent: () => ({
                    type: "payment_intent.canceled",
                    data: { object: { id: "pi_canceled", status: "canceled" } },
                }),
            },
        },
        env: { STRIPE_WEBHOOK_SECRET: "secret" },
        getOrderByProviderReference: (db, provider, reference) =>
            provider === "stripe" && reference === "pi_canceled" ? { id: 12 } : null,
        markOrderPaid: () => {},
        updateOrderStatus: (db, orderId, status, metadata) => calls.push(["status", orderId, status, metadata]),
    });

    const baseUrl = await listen(app, t);
    const response = await fetch(`${baseUrl}/webhooks/stripe`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "stripe-signature": "test",
        },
        body: JSON.stringify({}),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [["status", 12, "failed", {
        stripePaymentIntentId: "pi_canceled",
        paymentStatus: "canceled",
    }]]);
});

test("swiss bitcoin pay webhook verifies secret and applies mapped status", async (t) => {
    const app = express();
    const calls = [];

    registerTestWebhookRoutes({
        app,
        stripe: null,
        env: {},
        getOrderByProviderReference: (db, provider, reference) =>
            provider === "swissbitcoinpay" && reference === "invoice-1" ? { id: 12 } : null,
        markOrderPaid: (db, orderId, metadata) => calls.push(["paid", orderId, metadata]),
        updateOrderStatus: (db, orderId, status, metadata) => calls.push(["status", orderId, status, metadata]),
        verifySwissBitcoinPayWebhook: (req) => req.headers["x-test-secret"] === "ok",
        mapSwissBitcoinPayStatus: () => "paid",
    });

    const baseUrl = await listen(app, t);
    const response = await fetch(`${baseUrl}/webhooks/swiss-bitcoin-pay`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-test-secret": "ok",
        },
        body: JSON.stringify({
            id: "invoice-1",
            status: "paid",
            paymentMethod: "lightning",
            txId: "tx-1",
        }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [["paid", 12, {
        swissBitcoinPayInvoiceId: "invoice-1",
        invoiceStatus: "paid",
        paymentMethod: "lightning",
        txId: "tx-1",
    }]]);
});

test("Swiss Bitcoin Pay webhook recovers a missing invoice reference from the order number", async (t) => {
    const app = express();
    const calls = [];
    const pendingOrder = {
        id: 14,
        order_number: "RCT-RECOVER",
        provider: "swissbitcoinpay",
        provider_reference: null,
    };

    registerTestWebhookRoutes({
        app,
        getOrderByProviderReference: () => null,
        getOrderByNumber: (db, orderNumber) => orderNumber === pendingOrder.order_number ? pendingOrder : null,
        updateOrderProviderReference: (db, orderId, reference, metadata) => {
            calls.push(["reference", orderId, reference, metadata]);
            return { ...pendingOrder, provider_reference: reference };
        },
        markOrderPaid: (db, orderId, metadata) => calls.push(["paid", orderId, metadata]),
        updateOrderStatus: () => {},
        mapSwissBitcoinPayStatus: () => "paid",
    });

    const baseUrl = await listen(app, t);
    const response = await fetch(`${baseUrl}/webhooks/swiss-bitcoin-pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            id: "invoice-recovered",
            status: "paid",
            extra: { orderNumber: "RCT-RECOVER" },
        }),
    });

    assert.equal(response.status, 200);
    assert.equal(calls[0][0], "reference");
    assert.equal(calls[0][1], 14);
    assert.equal(calls[0][2], "invoice-recovered");
    assert.match(calls[0][3].swissBitcoinPayReferenceRecoveredAt, /^2026-|^20\d\d-/);
    assert.equal(calls[1][0], "paid");
    assert.equal(calls[1][1], 14);
});

test("shop-owned Stripe events are retried until their order is visible", async (t) => {
    const app = express();
    registerTestWebhookRoutes({
        app,
        stripe: {
            webhooks: {
                constructEvent: () => ({
                    type: "payment_intent.succeeded",
                    data: {
                        object: {
                            id: "pi_not_ready",
                            status: "succeeded",
                            metadata: { source: "recytech-shop" },
                        },
                    },
                }),
            },
        },
        env: { STRIPE_WEBHOOK_SECRET: "secret" },
        getOrderByProviderReference: () => null,
        markOrderPaid: () => {},
        updateOrderStatus: () => {},
    });

    const baseUrl = await listen(app, t);
    const response = await fetch(`${baseUrl}/webhooks/stripe`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": "test" },
        body: "{}",
    });

    assert.equal(response.status, 503);
});

test("Swiss Bitcoin Pay retries valid invoices until their order is visible", async (t) => {
    const app = express();
    registerTestWebhookRoutes({
        app,
        getOrderByProviderReference: () => null,
        markOrderPaid: () => {},
        updateOrderStatus: () => {},
    });

    const baseUrl = await listen(app, t);
    const response = await fetch(`${baseUrl}/webhooks/swiss-bitcoin-pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "invoice-not-ready", status: "paid" }),
    });

    assert.equal(response.status, 503);
});

test("webhook processing failures return generic retryable errors", async (t) => {
    const app = express();
    registerTestWebhookRoutes({
        app,
        getOrderByProviderReference: () => ({ id: 12, order_number: "RCT-FAIL" }),
        markOrderPaid: () => {
            throw new Error("private database detail");
        },
        updateOrderStatus: () => {},
        mapSwissBitcoinPayStatus: () => "paid",
    });

    const baseUrl = await listen(app, t);
    const response = await fetch(`${baseUrl}/webhooks/swiss-bitcoin-pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "invoice-1", status: "paid" }),
    });
    const body = await response.text();

    assert.equal(response.status, 500);
    assert.equal(body, "Webhook processing failed");
    assert.doesNotMatch(body, /private database detail/);
});
