const assert = require("node:assert/strict");
const test = require("node:test");
const { createStripeIntentService } = require("../lib/payments/stripe-intents");

function createService(overrides = {}) {
    const calls = [];
    const request = {
        session: {
            stripeDraft: overrides.existingDraft || null,
        },
    };
    const stripe = overrides.stripe || {
        paymentIntents: {
            create: async (payload) => {
                calls.push(["create", payload]);
                return {
                    id: "pi_created",
                    client_secret: "secret_created",
                };
            },
        },
    };
    const service = createStripeIntentService({
        stripe,
        paymentState: () => ({ stripeEnabled: overrides.stripeEnabled !== false }),
        buildCart: () => overrides.cart || {
            subtotalCents: 2000,
            items: [{ item_key: "product:1", quantity: 1, unit_price_cents: 2000 }],
        },
        buildCheckoutDraft: () => overrides.draftForm || {
            customer_email: "client@example.test",
            delivery_method: "pickup",
            promo_code: "",
        },
        getCheckoutForm: () => ({}),
        shippingOptions: {
            pickup: { key: "pickup", priceCents: 0 },
        },
        requirePromoCodeOutcome: () => overrides.promoCodeOutcome || {
            code: "",
            discountCents: 0,
            promoCode: null,
        },
        getCheckoutPricing: () => ({ totalCents: overrides.amountCents || 2000 }),
        getStripeDraft: (req) => req.session.stripeDraft,
        setStripeDraft: (req, draft) => {
            calls.push(["setDraft", draft]);
            req.session.stripeDraft = draft;
        },
        getRateLimitState: () => overrides.rateLimitState || { blockedUntil: 0 },
        registerAttempt: () => calls.push(["attempt"]),
    });

    return {
        calls,
        request,
        service,
    };
}

test("Stripe intent service rejects disabled card checkout", async () => {
    const { service, request } = createService({ stripeEnabled: false });

    await assert.rejects(
        service.createOrReuseStripeIntent(request, {}),
        /paiement par carte est indisponible/i
    );
});

test("Stripe intent service reuses the current session draft", async () => {
    const existingDraft = {
        paymentIntentId: "pi_existing",
        clientSecret: "secret_existing",
        amountCents: 2000,
        deliveryMethod: "pickup",
        promoCode: "",
        cartSignature: "product:1:1:2000",
    };
    const { calls, request, service } = createService({ existingDraft });

    const draft = await service.createOrReuseStripeIntent(request, {});

    assert.equal(draft, existingDraft);
    assert.deepEqual(calls, []);
});

test("Stripe intent service blocks rate-limited attempts before creating an intent", async () => {
    const { calls, request, service } = createService({
        rateLimitState: { blockedUntil: Date.now() + 60_000 },
    });

    await assert.rejects(
        service.createOrReuseStripeIntent(request, {}),
        /Trop de tentatives/
    );
    assert.deepEqual(calls, []);
});

test("Stripe intent service creates and stores a new draft", async () => {
    const { calls, request, service } = createService({
        promoCodeOutcome: {
            code: "MERCI",
            discountCents: 500,
            promoCode: { code: "MERCI" },
        },
        amountCents: 1500,
    });

    const draft = await service.createOrReuseStripeIntent(request, {});

    assert.deepEqual(draft, {
        paymentIntentId: "pi_created",
        clientSecret: "secret_created",
        amountCents: 1500,
        deliveryMethod: "pickup",
        promoCode: "MERCI",
        cartSignature: "product:1:1:2000",
    });
    assert.equal(request.session.stripeDraft, draft);
    assert.equal(calls[0][0], "attempt");
    assert.deepEqual(calls[1], ["create", {
        amount: 1500,
        currency: "chf",
        payment_method_types: ["card"],
        receipt_email: "client@example.test",
        metadata: {
            source: "recytech-shop",
            delivery_method: "pickup",
            promo_code: "MERCI",
        },
    }]);
    assert.equal(calls[2][0], "setDraft");
});
