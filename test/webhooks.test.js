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
    markOrderPaid,
    updateOrderStatus,
    verifySwissBitcoinPayWebhook = () => true,
    mapSwissBitcoinPayStatus = () => "pending",
}) {
    registerWebhookRoutes({
        app,
        db: {},
        providers: { stripe, env },
        repositories: {
            getOrderByProviderReference,
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
    assert.deepEqual(calls, [["paid", 10, {
        stripePaymentIntentId: "pi_test",
        paymentStatus: "succeeded",
    }]]);
});

test("stripe webhook marks failed and canceled payment intents failed", async (t) => {
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
    assert.deepEqual(calls, [["status", 11, "failed", {
        stripePaymentIntentId: "pi_failed",
        paymentStatus: "requires_payment_method",
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
