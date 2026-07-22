const assert = require("node:assert/strict");
const test = require("node:test");
const { createCheckoutOrderService } = require("../lib/checkout-order-service");
const database = require("../lib/db");

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

test("local checkout orders reserve the final unit atomically", (t) => {
    const db = database.initializeDatabase(":memory:", {
        NODE_ENV: "test",
        ADMIN_PASSWORD: "test-admin-password",
    });
    t.after(() => db.close());
    const product = database.createProduct(db, {
        product_kind: "product",
        name: "Final local checkout unit",
        categories: "Audit",
        price_chf: "25.00",
        inventory: "1",
        published: "1",
    });
    const cart = {
        subtotalCents: 2500,
        items: [{
            product_id: product.id,
            name: product.name,
            quantity: 1,
            unit_price_cents: 2500,
            line_total_cents: 2500,
            selected_options: [],
            service_tags: [],
        }],
    };
    const service = createCheckoutOrderService({
        db,
        buildCart: () => structuredClone(cart),
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
        createOrder: database.createOrder,
        reserveOrderInventory: database.reserveOrderInventory,
    });
    const input = {
        req: {},
        provider: "transfer",
        customer: {
            name: "Reservation Customer",
            email: "reservation@example.test",
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
    };

    const firstOrder = service.createCheckoutOrder(input).order;
    assert.ok(firstOrder.metadata.inventory_reserved_at);
    assert.equal(database.getProductById(db, product.id).inventory, 0);
    assert.throws(() => service.createCheckoutOrder(input), /Stock insuffisant/);
    assert.equal(database.countOrders(db), 1);
});

test("checkout idempotency reuses the original order and rejects changed payloads", (t) => {
    const db = database.initializeDatabase(":memory:", {
        NODE_ENV: "test",
        ADMIN_PASSWORD: "test-admin-password",
    });
    t.after(() => db.close());
    const service = createCheckoutOrderService({
        db,
        buildCart: () => ({
            subtotalCents: 2500,
            items: [{
                product_id: 1,
                name: "Idempotent item",
                quantity: 1,
                unit_price_cents: 2500,
                line_total_cents: 2500,
            }],
        }),
        requirePromoCodeOutcome: () => ({
            code: "",
            discountCents: 0,
            label: "",
            promoCode: null,
        }),
        getCheckoutPricing: () => ({ totalCents: 2500, discountLines: [] }),
        createOrder: database.createOrder,
        getOrderByIdempotencyKey: database.getOrderByIdempotencyKey,
    });
    const baseInput = {
        req: {},
        provider: "transfer",
        idempotencyKey: "a".repeat(32),
        customer: { name: "Same Customer", email: "same@example.test" },
        checkoutDetails: {
            form: { payment_method: "transfer", promo_code: "" },
            shippingOption: { key: "pickup", label: "Retrait", priceCents: 0 },
        },
    };

    const first = service.createCheckoutOrder(baseInput);
    const replay = service.createCheckoutOrder(baseInput);

    assert.equal(first.createdOrder, true);
    assert.equal(replay.createdOrder, false);
    assert.equal(replay.order.id, first.order.id);
    assert.equal(database.countOrders(db), 1);
    assert.throws(() => service.createCheckoutOrder({
        ...baseInput,
        customer: { ...baseInput.customer, email: "changed@example.test" },
    }), /contenu différent/);
});

test("checkout idempotency reuses its reserved final promo redemption", (t) => {
    const db = database.initializeDatabase(":memory:", {
        NODE_ENV: "test",
        ADMIN_PASSWORD: "test-admin-password",
    });
    t.after(() => db.close());
    const promoCode = database.createPromoCode(db, {
        code: "FINAL",
        discount_type: "fixed",
        discount_value: 500,
        active: true,
        max_redemptions: 1,
    });
    let promoValidationCalls = 0;
    const service = createCheckoutOrderService({
        db,
        buildCart: () => ({
            subtotalCents: 2500,
            items: [{
                product_id: 1,
                name: "Promo item",
                quantity: 1,
                unit_price_cents: 2500,
                line_total_cents: 2500,
            }],
        }),
        requirePromoCodeOutcome: () => {
            promoValidationCalls += 1;
            if (promoValidationCalls > 1) {
                throw new Error("This final redemption is now reserved");
            }
            return {
                code: promoCode.code,
                discountCents: 500,
                label: "Code promo FINAL",
                promoCode: {
                    id: promoCode.id,
                    code: promoCode.code,
                    description: promoCode.description,
                    discount_type: promoCode.discount_type,
                    discount_value: promoCode.discount_value,
                },
            };
        },
        getCheckoutPricing: (_subtotal, _shipping, _payment, promoOutcome) => ({
            totalCents: 2000,
            discountLines: [{
                type: "discount",
                code: promoOutcome.code,
                label: promoOutcome.label,
                amount_cents: -promoOutcome.discountCents,
            }],
        }),
        createOrder: database.createOrder,
        getOrderByIdempotencyKey: database.getOrderByIdempotencyKey,
    });
    const input = {
        req: {},
        provider: "transfer",
        idempotencyKey: "p".repeat(32),
        customer: { name: "Promo Customer", email: "promo@example.test" },
        checkoutDetails: {
            form: { payment_method: "transfer", promo_code: "FINAL" },
            shippingOption: { key: "pickup", label: "Retrait", priceCents: 0 },
        },
    };

    const first = service.createCheckoutOrder(input);
    const replay = service.createCheckoutOrder(input);

    assert.equal(first.createdOrder, true);
    assert.equal(replay.createdOrder, false);
    assert.equal(replay.order.id, first.order.id);
    assert.equal(promoValidationCalls, 1);
    assert.equal(database.getPromoCodeById(db, promoCode.id).times_redeemed, 1);
});
