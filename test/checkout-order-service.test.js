const assert = require("node:assert/strict");
const test = require("node:test");
const { createCheckoutOrderService } = require("../lib/checkout-order-service");

test("checkout order service builds consistent delivery, promo, and addition metadata", () => {
    const createdPayloads = [];
    const service = createCheckoutOrderService({
        db: { name: "test-db" },
        buildCart: () => ({
            subtotalCents: 10000,
            items: [{ product_id: 1, quantity: 1, unit_price_cents: 10000 }],
        }),
        requirePromoCodeOutcome: () => ({
            code: "SAVE10",
            discountCents: 1000,
            label: "Code promo SAVE10",
            promoCode: {
                id: 4,
                code: "SAVE10",
                description: "Test discount",
                discount_type: "percent",
                discount_value: 10,
            },
        }),
        getCheckoutPricing: () => ({
            totalCents: 10150,
            discountLines: [{
                type: "promo",
                label: "Code promo SAVE10",
                amount_cents: -1000,
            }],
        }),
        createOrder: (db, payload) => {
            assert.equal(db.name, "test-db");
            createdPayloads.push(payload);
            return { id: 12, order_number: "RT-12", ...payload };
        },
    });

    const { order, pricing, promoCodeOutcome } = service.createCheckoutOrder({
        req: {},
        provider: "stripe",
        providerReference: "pi_test",
        customer: {
            name: "Ada Lovelace",
            email: "ada@example.test",
        },
        checkoutDetails: {
            form: {
                payment_method: "card",
                promo_code: "SAVE10",
            },
            shippingOption: {
                key: "ship",
                label: "La Poste",
                priceCents: 1150,
            },
        },
        extraMetadata: {
            stripePaymentIntentId: "pi_test",
        },
    });

    assert.equal(order.provider, "stripe");
    assert.equal(order.provider_reference, "pi_test");
    assert.equal(order.status, "pending");
    assert.equal(pricing.totalCents, 10150);
    assert.equal(promoCodeOutcome.code, "SAVE10");
    assert.deepEqual(createdPayloads[0].metadata.delivery, {
        method: "ship",
        label: "La Poste",
        amount_cents: 1150,
    });
    assert.deepEqual(createdPayloads[0].metadata.additions, [
        {
            type: "shipping",
            label: "La Poste",
            amount_cents: 1150,
        },
        {
            type: "promo",
            label: "Code promo SAVE10",
            amount_cents: -1000,
        },
    ]);
    assert.deepEqual(createdPayloads[0].metadata.promo, {
        id: 4,
        code: "SAVE10",
        description: "Test discount",
        discount_type: "percent",
        discount_value: 10,
        discount_cents: 1000,
        label: "Code promo SAVE10",
    });
    assert.equal(createdPayloads[0].metadata.stripePaymentIntentId, "pi_test");
});

test("checkout order service marks transfer orders as awaiting transfer", () => {
    const service = createCheckoutOrderService({
        db: {},
        buildCart: () => ({
            subtotalCents: 2500,
            items: [{ product_id: 2, quantity: 1, unit_price_cents: 2500 }],
        }),
        requirePromoCodeOutcome: () => ({
            code: "",
            discountCents: 0,
            label: "",
            promoCode: null,
        }),
        getCheckoutPricing: () => ({
            totalCents: 2500,
            discountLines: [],
        }),
        createOrder: (_db, payload) => payload,
    });

    const { order } = service.createCheckoutOrder({
        req: {},
        provider: "transfer",
        customer: {
            name: "Grace Hopper",
            email: "grace@example.test",
        },
        checkoutDetails: {
            form: {
                payment_method: "transfer",
                promo_code: "",
            },
            shippingOption: {
                key: "pickup",
                label: "Retrait",
                priceCents: 0,
            },
        },
    });

    assert.equal(order.status, "awaiting_transfer");
    assert.equal(order.metadata.promo, null);
    assert.deepEqual(order.metadata.additions, []);
});
