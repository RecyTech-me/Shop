const assert = require("node:assert/strict");
const test = require("node:test");
const logger = require("../lib/logger");
const { registerCheckoutRoutes } = require("../routes/checkout");

logger.configureLogger({ level: "silent" });

function createResponse(cart = { items: [{ product_id: 1 }], subtotalCents: 2000 }) {
    return {
        locals: { cart },
        redirects: [],
        renders: [],
        statusCode: 200,
        redirect(target) {
            this.redirects.push(target);
            this.redirectedTo = target;
            return this;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        render(view, options) {
            this.renders.push({ view, options });
            this.rendered = { view, options };
            return this;
        },
    };
}

function createCheckoutDetails(paymentMethod) {
    return {
        form: {
            payment_method: paymentMethod,
            delivery_method: "pickup",
            promo_code: "",
        },
        customer: {
            name: "Ada Client",
            email: "ada@example.test",
        },
        shippingOption: {
            key: "pickup",
            label: "Retrait",
            priceCents: 0,
        },
    };
}

function registerRoutes(overrides = {}) {
    const handlers = new Map();
    const calls = [];
    const ordersByNumber = new Map([
        ["RCT-TRANSFER", { id: 20, order_number: "RCT-TRANSFER", provider: "transfer" }],
        ["RCT-CASH", { id: 21, order_number: "RCT-CASH", provider: "cash" }],
    ]);
    const ordersByProviderReference = new Map([
        ["pi_succeeded", { id: 10, order_number: "RCT-STRIPE", provider_reference: "pi_succeeded" }],
        ["pi_processing", { id: 11, order_number: "RCT-PROCESSING", provider_reference: "pi_processing" }],
        ["pi_throw", { id: 12, order_number: "RCT-THROW", provider_reference: "pi_throw" }],
    ]);
    const deps = {
        app: {
            get(path, handler) {
                handlers.set(`GET ${path}`, handler);
            },
            post(path, handler) {
                handlers.set(`POST ${path}`, handler);
            },
        },
        db: {},
        providers: {
            stripe: {
                paymentIntents: {
                    retrieve: async (id) => {
                        calls.push(["stripeRetrieve", id]);
                        if (id === "pi_throw") {
                            throw new Error("Stripe unavailable");
                        }

                        return {
                            id,
                            status: id === "pi_processing" ? "processing" : "succeeded",
                        };
                    },
                },
            },
            ...overrides.providers,
        },
        formatters: {
            SHIPPING_OPTIONS: {
                pickup: { key: "pickup", label: "Retrait", priceCents: 0 },
            },
        },
        http: {
            render: (res, view, options) => {
                calls.push(["render", view, options]);
                res.render(view, options);
            },
            setFlash: (req, type, message) => {
                calls.push(["flash", type, message]);
                req.flashes.push({ type, message });
            },
            saveSessionAndRedirect: (req, res, target) => {
                calls.push(["redirect", target]);
                res.redirect(target);
            },
        },
        cart: {
            setCartItems: (req, items) => {
                calls.push(["setCartItems", items]);
                req.cartItems = items;
            },
        },
        checkout: {
            abandonCheckoutAttempt: (req, attemptId) => {
                calls.push(["abandonCheckoutAttempt", attemptId]);
            },
            getCheckoutPricing: () => ({ totalCents: 2000 }),
            getCheckoutForm: () => ({ delivery_method: "pickup", payment_method: "transfer", promo_code: "" }),
            getPromoCodeOutcome: () => ({ error: "", code: "" }),
            getOrCreateCheckoutAttemptId: () => "a".repeat(32),
            getCompletedCheckoutOrderId: () => null,
            requireCheckoutAttemptId: () => "a".repeat(32),
            completeCheckoutAttempt: (req, attemptId, orderId) => {
                calls.push(["completeCheckoutAttempt", attemptId, orderId]);
            },
            setCheckoutForm: (req, form) => {
                calls.push(["setCheckoutForm", form.payment_method]);
                req.checkoutForm = form;
            },
            clearCheckoutForm: (req) => {
                calls.push(["clearCheckoutForm"]);
                req.checkoutForm = null;
            },
            clearStripeDraft: (req) => {
                calls.push(["clearStripeDraft"]);
                req.stripeDraft = null;
            },
            createCheckoutOrder: () => {
                calls.push(["createCheckoutOrder"]);
                return {
                    order: {
                        id: 30,
                        order_number: "RCT-BTC",
                        provider: "swissbitcoinpay",
                    },
                    createdOrder: true,
                };
            },
            ...overrides.checkout,
        },
        forms: {
            validateCheckout: () => createCheckoutDetails(overrides.paymentMethod || "transfer"),
        },
        payments: {
            paymentState: () => ({
                stripeEnabled: true,
                bitcoinEnabled: true,
                ...overrides.paymentState,
            }),
            createSwissBitcoinPayInvoice: async () => ({
                id: "invoice-1",
                checkoutUrl: "https://pay.example.test/invoice-1",
                pr: "lnbc",
                onChainAddr: "bc1q",
            }),
            createOrderViewToken: (order) => `view-${order.order_number}`,
            fetchSwissBitcoinPayInvoice: async (invoiceId) => ({
                id: invoiceId,
                status: "paid",
                isPaid: true,
            }),
            mapSwissBitcoinPayStatus: (invoice) => (invoice.isPaid ? "paid" : "pending"),
            verifyOrderViewToken: (order, token) => token === `view-${order.order_number}`,
            ...overrides.payments,
        },
        orders: {
            updateOrderProviderReference: (db, orderId, providerReference, metadata) => {
                calls.push(["updateProviderReference", orderId, providerReference, metadata]);
            },
            getOrderByProviderReference: (db, provider, reference) => ordersByProviderReference.get(reference) || null,
            getOrderById: () => null,
            markOrderPaid: (db, orderId, metadata) => {
                calls.push(["markPaid", orderId, metadata]);
                return { id: orderId, order_number: "RCT-PAID", status: "paid" };
            },
            updateOrderStatus: (db, orderId, status, metadata) => {
                calls.push(["updateStatus", orderId, status, metadata]);
                return { id: orderId, order_number: "RCT-UPDATED", status };
            },
            getOrderByNumber: (db, orderNumber) => ordersByNumber.get(orderNumber) || null,
            ...overrides.orders,
        },
        mail: {
            notifyNewOrder: async (order) => {
                calls.push(["notifyNewOrder", order.order_number]);
            },
        },
    };

    if (overrides.forms) {
        deps.forms = { ...deps.forms, ...overrides.forms };
    }

    registerCheckoutRoutes(deps);

    return {
        calls,
        handler(method, path) {
            return handlers.get(`${method} ${path}`);
        },
    };
}

function createRequest(options = {}) {
    return {
        query: {},
        body: {},
        flashes: [],
        ...options,
    };
}

test("checkout page redirects an empty cart", () => {
    const { calls, handler } = registerRoutes();
    const req = createRequest();
    const res = createResponse({ items: [], subtotalCents: 0 });

    handler("GET", "/checkout")(req, res);

    assert.equal(res.redirectedTo, "/cart");
    assert.deepEqual(calls[0], ["flash", "error", "Votre panier est vide."]);
});

test("checkout card POST uses the in-page Stripe fallback message", async () => {
    const { calls, handler } = registerRoutes({ paymentMethod: "card" });
    const req = createRequest();
    const res = createResponse();

    await handler("POST", "/checkout")(req, res);

    assert.equal(res.redirectedTo, "/checkout");
    assert.ok(calls.some((call) => call[0] === "setCheckoutForm" && call[1] === "card"));
    assert.ok(calls.some((call) => call[0] === "flash" && /finalise directement/.test(call[2])));
});

test("checkout bitcoin POST rejects disabled provider", async () => {
    const { calls, handler } = registerRoutes({
        paymentMethod: "bitcoin",
        paymentState: { bitcoinEnabled: false },
    });
    const req = createRequest();
    const res = createResponse();

    await handler("POST", "/checkout")(req, res);

    assert.equal(res.redirectedTo, "/checkout");
    assert.ok(calls.some((call) => call[0] === "flash" && /bitcoin est indisponible/.test(call[2])));
    assert.ok(!calls.some((call) => call[0] === "createCheckoutOrder"));
});

test("checkout preserves a bitcoin reservation when invoice creation is uncertain", async () => {
    const { calls, handler } = registerRoutes({
        paymentMethod: "bitcoin",
        payments: {
            createSwissBitcoinPayInvoice: async () => {
                throw new Error("invoice down");
            },
        },
    });
    const req = createRequest();
    const res = createResponse();

    await handler("POST", "/checkout")(req, res);

    assert.equal(res.redirectedTo, "/checkout");
    assert.ok(calls.some((call) => call[0] === "updateStatus" && call[2] === "pending" && call[3].swissBitcoinPayInvoiceOutcome === "unknown"));
    assert.ok(!calls.some((call) => call[0] === "abandonCheckoutAttempt"));
    assert.ok(!calls.some((call) => call[0] === "completeCheckoutAttempt"));
    assert.ok(!calls.some((call) => call[0] === "notifyNewOrder"));
    assert.ok(calls.some((call) => call[0] === "flash" && /paiement bitcoin est incertain/.test(call[2])));
});

test("checkout releases a bitcoin reservation after a definite provider rejection", async () => {
    const providerError = new Error("invoice rejected");
    providerError.providerOutcomeKnownFailed = true;
    const { calls, handler } = registerRoutes({
        paymentMethod: "bitcoin",
        payments: {
            createSwissBitcoinPayInvoice: async () => {
                throw providerError;
            },
        },
    });

    await handler("POST", "/checkout")(createRequest(), createResponse());

    assert.ok(calls.some((call) => call[0] === "updateStatus" && call[2] === "failed" && call[3].swissBitcoinPayInvoiceOutcome === "rejected"));
    assert.ok(calls.some((call) => call[0] === "abandonCheckoutAttempt"));
});

test("checkout bitcoin completes the attempt only after invoice creation", async () => {
    const { calls, handler } = registerRoutes({ paymentMethod: "bitcoin" });
    const req = createRequest();
    const res = createResponse();

    await handler("POST", "/checkout")(req, res);

    const providerUpdateIndex = calls.findIndex((call) => call[0] === "updateProviderReference");
    const completionIndex = calls.findIndex((call) => call[0] === "completeCheckoutAttempt");
    const notificationIndex = calls.findIndex((call) => call[0] === "notifyNewOrder");
    assert.ok(providerUpdateIndex >= 0);
    assert.ok(completionIndex > providerUpdateIndex);
    assert.ok(notificationIndex > providerUpdateIndex);
    assert.equal(res.redirectedTo, "https://pay.example.test/invoice-1");
});

test("checkout success marks succeeded Stripe intents paid", async () => {
    const { calls, handler } = registerRoutes();
    const req = createRequest({
        query: {
            provider: "stripe",
            payment_intent: "pi_succeeded",
            view: "view-RCT-STRIPE",
        },
    });
    const res = createResponse();

    await handler("GET", "/checkout/success")(req, res);

    assert.ok(calls.some((call) => call[0] === "markPaid" && call[1] === 10));
    assert.ok(calls.some((call) => call[0] === "setCartItems"));
    assert.equal(res.rendered.view, "success");
    assert.equal(res.rendered.options.order.status, "paid");
});

test("checkout success records uncertain Stripe failures without exposing an order", async () => {
    const { calls, handler } = registerRoutes();
    const req = createRequest({
        query: {
            provider: "stripe",
            payment_intent: "pi_throw",
            view: "view-RCT-THROW",
        },
    });
    const res = createResponse();

    await handler("GET", "/checkout/success")(req, res);

    assert.ok(calls.some((call) => call[0] === "flash" && /statut incertain/.test(call[2])));
    assert.ok(!calls.some((call) => call[0] === "flash" && /Stripe unavailable/.test(call[2])));
    assert.equal(res.rendered.view, "success");
    assert.equal(res.rendered.options.order, null);
});

test("checkout success does not query Stripe for an invalid order capability", async () => {
    const { calls, handler } = registerRoutes();
    const req = createRequest({
        query: {
            provider: "stripe",
            payment_intent: "pi_succeeded",
            view: "invalid",
        },
    });
    const res = createResponse();

    await handler("GET", "/checkout/success")(req, res);

    assert.ok(!calls.some((call) => call[0] === "stripeRetrieve"));
    assert.ok(!calls.some((call) => call[0] === "clearCheckoutForm"));
    assert.ok(!calls.some((call) => call[0] === "clearStripeDraft"));
    assert.equal(res.rendered.options.order, null);
});

test("checkout success keeps processing Stripe intents pending", async () => {
    const { calls, handler } = registerRoutes();
    const req = createRequest({
        query: {
            provider: "stripe",
            payment_intent: "pi_processing",
            view: "view-RCT-PROCESSING",
        },
    });
    const res = createResponse();

    await handler("GET", "/checkout/success")(req, res);

    assert.ok(calls.some((call) => call[0] === "updateStatus" && call[1] === 11 && call[2] === "pending"));
    assert.equal(res.rendered.options.order.status, "pending");
});

test("checkout success validates transfer and cash order tokens", async () => {
    for (const [provider, orderNumber] of [["transfer", "RCT-TRANSFER"], ["cash", "RCT-CASH"]]) {
        const { calls, handler } = registerRoutes();
        const req = createRequest({
            query: {
                provider,
                order: orderNumber,
                view: `view-${orderNumber}`,
            },
        });
        const res = createResponse();

        await handler("GET", "/checkout/success")(req, res);

        assert.equal(res.rendered.view, "success");
        assert.equal(res.rendered.options.order.order_number, orderNumber);
        assert.ok(calls.some((call) => call[0] === "setCartItems"));
    }
});

test("checkout cancel only exposes an order with its bound view token", () => {
    const { handler } = registerRoutes();

    for (const [view, expectedOrder] of [["invalid", null], ["view-RCT-CASH", "RCT-CASH"]]) {
        const req = createRequest({ query: { order: "RCT-CASH", view } });
        const res = createResponse();

        handler("GET", "/checkout/cancel")(req, res);

        assert.equal(res.rendered.view, "cancel");
        assert.equal(res.rendered.options.order?.order_number || null, expectedOrder);
    }
});
