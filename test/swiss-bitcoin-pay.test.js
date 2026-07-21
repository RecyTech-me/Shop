const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
    WEBHOOK_SECRET_HEADER,
    createSwissBitcoinPayService,
    mapSwissBitcoinPayStatus,
    requireSecureCheckoutUrl,
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

test("Swiss Bitcoin Pay checkout URLs are canonical and header-safe", () => {
    assert.equal(
        requireSecureCheckoutUrl("  https://pay.example.test/invoice?q=1  "),
        "https://pay.example.test/invoice?q=1"
    );
    assert.throws(
        () => requireSecureCheckoutUrl("https://pay.example.test/invoice\r\nX-Injected: yes"),
        /URL de paiement HTTPS valide/
    );
    assert.throws(
        () => requireSecureCheckoutUrl(`https://pay.example.test/${"a".repeat(2048)}`),
        /URL de paiement HTTPS valide/
    );
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
        (error) => /503 unavailable/.test(error.message) && error.providerOutcomeKnownFailed === false
    );
});

test("Swiss Bitcoin Pay marks client-side invoice rejections as definitive", async () => {
    const service = createService({
        fetchImpl: async () => ({
            ok: false,
            status: 400,
            text: async () => "invalid invoice",
        }),
    });

    await assert.rejects(
        service.createInvoice({
            order_number: "RCT-REJECTED",
            amount_cents: 1200,
            currency: "CHF",
            customer_email: "client@example.test",
            items: [],
        }, {}),
        (error) => /400 invalid invoice/.test(error.message) && error.providerOutcomeKnownFailed === true
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
        /URL de paiement HTTPS valide/
    );
});

test("Swiss Bitcoin Pay invoice creation rejects missing identities and unsafe redirects", async () => {
    const order = {
        order_number: "RCT-INVALID",
        amount_cents: 1200,
        currency: "CHF",
        customer_email: "client@example.test",
        items: [],
    };
    const missingIdService = createService({
        fetchImpl: async () => ({
            ok: true,
            json: async () => ({ checkoutUrl: "https://pay.example.test/invoice" }),
        }),
    });
    const unsafeRedirectService = createService({
        fetchImpl: async () => ({
            ok: true,
            json: async () => ({ id: "invoice-unsafe", checkoutUrl: "javascript:alert(1)" }),
        }),
    });

    await assert.rejects(missingIdService.createInvoice(order, {}), /identifiant de facture/);
    await assert.rejects(unsafeRedirectService.createInvoice(order, {}), /URL de paiement HTTPS valide/);
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

test("Swiss Bitcoin Pay invoice fetch rejects mismatched invoice identities", async () => {
    const service = createService({
        fetchImpl: async () => ({
            ok: true,
            json: async () => ({ id: "invoice-other", status: "paid" }),
        }),
    });

    await assert.rejects(
        service.fetchInvoice("invoice-requested"),
        /facture différente/
    );
});
