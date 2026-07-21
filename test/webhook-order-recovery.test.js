const assert = require("node:assert/strict");
const test = require("node:test");
const {
    findSwissBitcoinPayOrder,
    stripeFailureOrderStatus,
} = require("../routes/webhooks");

test("only a canceled Stripe PaymentIntent is terminal for the reserved order", () => {
    assert.equal(stripeFailureOrderStatus("payment_intent.payment_failed"), "pending");
    assert.equal(stripeFailureOrderStatus("payment_intent.canceled"), "failed");
});

const normalizeText = (value) => String(value || "").trim();

test("Swiss Bitcoin Pay order lookup recovers only an unbound matching provider order", () => {
    const pendingOrder = {
        id: 14,
        order_number: "RCT-RECOVER",
        provider: "swissbitcoinpay",
        provider_reference: null,
    };
    const updates = [];
    const resolved = findSwissBitcoinPayOrder({
        db: {},
        invoice: { extra: { orderNumber: pendingOrder.order_number } },
        invoiceId: "invoice-recovered",
        getOrderByProviderReference: () => null,
        getOrderByNumber: () => pendingOrder,
        updateOrderProviderReference: (db, orderId, reference, metadata) => {
            updates.push({ orderId, reference, metadata });
            return { ...pendingOrder, provider_reference: reference };
        },
        normalizeText,
        nowIso: () => "2026-07-21T12:00:00.000Z",
    });

    assert.equal(resolved.recovered, true);
    assert.equal(resolved.order.provider_reference, "invoice-recovered");
    assert.deepEqual(updates, [{
        orderId: 14,
        reference: "invoice-recovered",
        metadata: { swissBitcoinPayReferenceRecoveredAt: "2026-07-21T12:00:00.000Z" },
    }]);

    for (const unsafeOrder of [
        { ...pendingOrder, provider: "stripe" },
        { ...pendingOrder, provider_reference: "invoice-other" },
    ]) {
        const rejected = findSwissBitcoinPayOrder({
            db: {},
            invoice: { extra: { orderNumber: pendingOrder.order_number } },
            invoiceId: "invoice-recovered",
            getOrderByProviderReference: () => null,
            getOrderByNumber: () => unsafeOrder,
            updateOrderProviderReference: () => {
                throw new Error("unsafe order must not be rebound");
            },
            normalizeText,
        });
        assert.deepEqual(rejected, { order: null, recovered: false });
    }
});
