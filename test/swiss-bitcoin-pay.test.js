const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
    WEBHOOK_SECRET_HEADER,
    createSwissBitcoinPayService,
    mapSwissBitcoinPayStatus,
} = require("../lib/payments/swiss-bitcoin-pay");

function createService(overrides = {}) {
    return createSwissBitcoinPayService({
        apiUrl: "https://sbp.example.test",
        apiKey: "api-key",
        webhookSecret: "webhook-secret",
        baseUrl: () => "https://shop.example.test",
        createOrderViewToken: () => "view-token",
        ...overrides,
    });
}

test("Swiss Bitcoin Pay status mapper handles paid, expired, and pending invoices", () => {
    assert.equal(mapSwissBitcoinPayStatus({ isPaid: true }), "paid");
    assert.equal(mapSwissBitcoinPayStatus({ status: "paid" }), "paid");
    assert.equal(mapSwissBitcoinPayStatus({ isExpired: true }), "failed");
    assert.equal(mapSwissBitcoinPayStatus({ status: "expired" }), "failed");
    assert.equal(mapSwissBitcoinPayStatus({ status: "new" }), "pending");
});

test("Swiss Bitcoin Pay webhook verification accepts custom secret and HMAC fallback", () => {
    const service = createService();
    const payload = Buffer.from(JSON.stringify({ id: "invoice-1" }));
    const signature = crypto.createHmac("sha256", "webhook-secret").update(payload).digest("hex");

    assert.equal(service.verifyWebhook({
        headers: { [WEBHOOK_SECRET_HEADER]: "webhook-secret" },
        body: payload,
    }), true);
    assert.equal(service.verifyWebhook({
        headers: { "sbp-sig": `sha256=${signature}` },
        body: payload,
    }), true);
    assert.equal(service.verifyWebhook({
        headers: { [WEBHOOK_SECRET_HEADER]: "wrong-secret" },
        body: payload,
    }), false);
});

test("Swiss Bitcoin Pay invoice creation fails on provider errors", async (t) => {
    const originalFetch = global.fetch;
    t.after(() => {
        global.fetch = originalFetch;
    });
    global.fetch = async () => ({
        ok: false,
        status: 503,
        text: async () => "unavailable",
    });
    const service = createService();

    await assert.rejects(
        service.createInvoice({
            order_number: "RCT-FAIL",
            amount_cents: 1200,
            currency: "CHF",
            customer_email: "client@example.test",
            items: [],
        }, {}),
        /503 unavailable/
    );
});

test("Swiss Bitcoin Pay invoice creation requires a checkout URL", async (t) => {
    const originalFetch = global.fetch;
    t.after(() => {
        global.fetch = originalFetch;
    });
    global.fetch = async () => ({
        ok: true,
        json: async () => ({ id: "invoice-no-url" }),
    });
    const service = createService();

    await assert.rejects(
        service.createInvoice({
            order_number: "RCT-NOURL",
            amount_cents: 1200,
            currency: "CHF",
            customer_email: "client@example.test",
            items: [],
        }, {}),
        /URL de paiement/
    );
});

test("Swiss Bitcoin Pay invoice fetch reports provider failures", async (t) => {
    const originalFetch = global.fetch;
    t.after(() => {
        global.fetch = originalFetch;
    });
    global.fetch = async () => ({
        ok: false,
        status: 404,
        text: async () => "missing",
    });
    const service = createService();

    await assert.rejects(
        service.fetchInvoice("invoice-missing"),
        /404 missing/
    );
});
