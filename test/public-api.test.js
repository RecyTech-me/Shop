const assert = require("node:assert/strict");
const test = require("node:test");
const { registerPublicApiRoutes } = require("../routes/public-api");
const logger = require("../lib/logger");
const { isStripeDraftCurrent } = require("../lib/payments/stripe-intents");

logger.configureLogger({ level: "silent" });

function createResponse() {
    return {
        statusCode: 200,
        payload: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
            return this;
        },
    };
}

function registerStripePrepareRoute(overrides = {}) {
    const handlers = new Map();
    const calls = [];
    const stripe = typeof overrides.stripe === "function" ? overrides.stripe(calls) : overrides.stripe || {
        paymentIntents: {
            retrieve: async (id) => {
                calls.push(["retrieve", id]);
                return {
                    id,
                    status: "requires_payment_method",
                    currency: "chf",
                    amount: 2000,
                };
            },
            update: async (id, input) => {
                calls.push(["update", id, input]);
                return {};
            },
        },
    };
    const checkout = {
        setCheckoutForm: () => calls.push(["setCheckoutForm"]),
        buildCheckoutDraft: () => ({}),
        getCheckoutForm: () => ({}),
        requireCheckoutAttemptId: () => "a".repeat(32),
        completeCheckoutAttempt: (req, attemptId, orderId) => {
            calls.push(["completeCheckoutAttempt", attemptId, orderId]);
        },
        getStripeDraft: (req) => req.session.stripeDraft || null,
        clearStripeDraft: (req) => {
            calls.push(["clearStripeDraft"]);
            delete req.session.stripeDraft;
        },
        getPromoCodeOutcome: () => ({ error: "" }),
        assertPreparedCheckoutOrderMatch: (preparedOrder, order) => {
            calls.push(["assertPreparedCheckoutOrderMatch", preparedOrder, order]);
            return order;
        },
        validateCheckoutInput: () => ({
            form: {
                payment_method: "card",
                delivery_method: "pickup",
                promo_code: "",
            },
            customer: {
                name: "Test Customer",
                email: "client@example.test",
            },
            shippingOption: {
                key: "pickup",
                label: "Retrait",
                priceCents: 0,
            },
        }),
        prepareCheckoutOrder: () => ({
            cart: {
                items: [{
                    item_key: "product:1",
                    quantity: 1,
                    unit_price_cents: 2000,
                }],
            },
            pricing: {
                totalCents: 2000,
            },
            promoCodeOutcome: {
                code: "",
            },
        }),
        createOrReuseReservedPreparedCheckoutOrder: () => {
            calls.push(["createOrReuseReservedPreparedCheckoutOrder"]);
            return {
                order: {
                    id: 1,
                    order_number: "RCT-TEST",
                },
                createdOrder: true,
            };
        },
        ...overrides.checkout,
    };

    registerPublicApiRoutes({
        app: {
            options() {},
            get() {},
            post(path, handler) {
                handlers.set(path, handler);
            },
        },
        db: {},
        providers: { stripe },
        http: {
            setFlash: () => {},
            saveSessionAndRedirect: () => {},
        },
        text: {
            normalizeText: (value) => String(value || "").trim(),
        },
        publicProducts: {
            setPublicApiHeaders: () => {},
            serializePublicProduct: () => ({}),
        },
        cart: {
            buildCart: () => ({ items: [{ id: 1 }], subtotalCents: 2000 }),
        },
        checkout,
        payments: {
            createOrReuseStripeIntent: async () => ({}),
            paymentState: () => ({ stripeEnabled: true }),
            isStripeDraftCurrent,
            createOrderViewToken: () => "view-token",
            ...overrides.payments,
        },
        products: {
            listPublishedProducts: () => [],
        },
        orders: {
            getOrderByProviderReference: () => null,
            ...overrides.orders,
        },
        mail: {
            notifyNewOrder: async () => calls.push(["notifyNewOrder"]),
            ...overrides.mail,
        },
    });

    return {
        calls,
        handler: handlers.get("/checkout/stripe/prepare"),
    };
}

test("Stripe prepare rejects PaymentIntent ids outside the session draft", async () => {
    const { calls, handler } = registerStripePrepareRoute();
    const req = {
        body: { stripe_payment_intent_id: "pi_other" },
        session: {
            stripeDraft: {
                paymentIntentId: "pi_session",
                clientSecret: "secret",
            },
        },
    };
    const res = createResponse();

    await handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /Session de paiement Stripe/);
    assert.deepEqual(calls, []);
});

test("Stripe prepare rejects stale session drafts after cart or amount changes", async () => {
    const { calls, handler } = registerStripePrepareRoute();
    const req = {
        body: { stripe_payment_intent_id: "pi_session" },
        session: {
            stripeDraft: {
                paymentIntentId: "pi_session",
                clientSecret: "secret",
                amountCents: 1000,
                deliveryMethod: "pickup",
                promoCode: "",
                cartSignature: "product:1:1:1000",
            },
        },
    };
    const res = createResponse();

    await handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /plus à jour/);
    assert.ok(calls.some((call) => call[0] === "retrieve"));
    assert.ok(!calls.some((call) => call[0] === "createOrReuseReservedPreparedCheckoutOrder"));
});

test("Stripe prepare rejects canceled PaymentIntents and clears the draft", async () => {
    const { calls, handler } = registerStripePrepareRoute({
        stripe: (calls) => ({
            paymentIntents: {
                retrieve: async (id) => {
                    calls.push(["retrieve", id]);
                    return {
                        id,
                        status: "canceled",
                        currency: "chf",
                        amount: 2000,
                    };
                },
                update: async () => {},
            },
        }),
    });
    const req = {
        body: { stripe_payment_intent_id: "pi_session" },
        session: {
            stripeDraft: {
                paymentIntentId: "pi_session",
                clientSecret: "secret",
                amountCents: 2000,
                deliveryMethod: "pickup",
                promoCode: "",
                cartSignature: "product:1:1:2000",
            },
        },
    };
    const res = createResponse();

    await handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /Stripe/);
    assert.equal(req.session.stripeDraft, undefined);
    assert.ok(!calls.some((call) => call[0] === "createOrReuseReservedPreparedCheckoutOrder"));
});

test("Stripe prepare creates a reserved order and updates PaymentIntent metadata", async () => {
    const { calls, handler } = registerStripePrepareRoute();
    const req = {
        body: { stripe_payment_intent_id: "pi_session" },
        session: {
            stripeDraft: {
                paymentIntentId: "pi_session",
                clientSecret: "secret",
                amountCents: 2000,
                deliveryMethod: "pickup",
                promoCode: "",
                cartSignature: "product:1:1:2000",
            },
            save(callback) {
                calls.push(["sessionSave"]);
                callback();
            },
        },
    };
    const res = createResponse();

    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.orderNumber, "RCT-TEST");
    assert.match(res.payload.successUrl, /\/checkout\/success\?provider=stripe/);
    assert.match(res.payload.successUrl, /payment_intent=pi_session/);
    assert.match(res.payload.successUrl, /view=view-token/);
    assert.ok(calls.some((call) => call[0] === "setCheckoutForm"));
    assert.ok(calls.some((call) => call[0] === "createOrReuseReservedPreparedCheckoutOrder"));
    assert.ok(calls.some((call) => call[0] === "notifyNewOrder"));
    assert.ok(calls.some((call) => call[0] === "sessionSave"));

    const updateCall = calls.find((call) => call[0] === "update");
    assert.ok(updateCall);
    assert.equal(updateCall[1], "pi_session");
    assert.equal(updateCall[2].receipt_email, "client@example.test");
    assert.deepEqual(updateCall[2].metadata, {
        source: "recytech-shop",
        order_number: "RCT-TEST",
        delivery_method: "pickup",
        promo_code: "",
    });
});

test("Stripe prepare reuses an existing provider order without reserving stock twice", async () => {
    const { calls, handler } = registerStripePrepareRoute({
        orders: {
            getOrderByProviderReference: () => ({
                id: 10,
                order_number: "RCT-EXISTING",
            }),
        },
    });
    const req = {
        body: { stripe_payment_intent_id: "pi_session" },
        session: {
            stripeDraft: {
                paymentIntentId: "pi_session",
                clientSecret: "secret",
                amountCents: 2000,
                deliveryMethod: "pickup",
                promoCode: "",
                cartSignature: "product:1:1:2000",
            },
            save(callback) {
                calls.push(["sessionSave"]);
                callback();
            },
        },
    };
    const res = createResponse();

    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.orderNumber, "RCT-EXISTING");
    assert.ok(calls.some((call) => call[0] === "assertPreparedCheckoutOrderMatch"));
    assert.ok(!calls.some((call) => call[0] === "createOrReuseReservedPreparedCheckoutOrder"));
    assert.ok(!calls.some((call) => call[0] === "notifyNewOrder"));
    assert.ok(calls.some((call) => call[0] === "update"));
});

test("Stripe prepare rejects a changed payload for an existing provider order", async () => {
    const { calls, handler } = registerStripePrepareRoute({
        checkout: {
            assertPreparedCheckoutOrderMatch: () => {
                throw new Error("Cette tentative de commande a déjà été utilisée avec un contenu différent.");
            },
        },
        orders: {
            getOrderByProviderReference: () => ({
                id: 10,
                order_number: "RCT-EXISTING",
            }),
        },
    });
    const req = {
        body: { stripe_payment_intent_id: "pi_session" },
        session: {
            stripeDraft: {
                paymentIntentId: "pi_session",
                clientSecret: "secret",
                amountCents: 2000,
                deliveryMethod: "pickup",
                promoCode: "",
                cartSignature: "product:1:1:2000",
            },
        },
    };
    const res = createResponse();

    await handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.payload.error, /contenu différent/);
    assert.ok(!calls.some((call) => call[0] === "update"));
});
