const assert = require("node:assert/strict");
const test = require("node:test");
const { createCheckoutStateHelpers } = require("../lib/checkout-state");

function createHelpers(overrides = {}) {
    const promoCodes = new Map(Object.entries(overrides.promoCodes || {}));
    const paymentConfig = {
        stripeEnabled: true,
        bitcoinEnabled: true,
        ...overrides.paymentConfig,
    };

    return createCheckoutStateHelpers({
        SHIPPING_OPTIONS: {
            ship: { key: "ship", label: "Expédition", priceCents: 900 },
            pickup: { key: "pickup", label: "Retrait", priceCents: 0 },
        },
        PAYMENT_DISCOUNT_RATE: 0.1,
        formatMoney: (cents) => `CHF ${(cents / 100).toFixed(2)}`,
        getPromoCodeByCode: (code) => promoCodes.get(code) || null,
        normalizeText: (value) => String(value || "").trim(),
        paymentState: () => paymentConfig,
    });
}

test("checkout pricing stacks promo and cash discounts on the remaining subtotal", () => {
    const helpers = createHelpers();
    const promoOutcome = {
        code: "MERCI",
        promoCode: { code: "MERCI" },
        discountCents: 1000,
        label: "Code promo MERCI",
        error: "",
    };

    const pricing = helpers.getCheckoutPricing(
        10000,
        { key: "pickup", label: "Retrait", priceCents: 0 },
        "cash",
        promoOutcome
    );

    assert.equal(pricing.promoDiscountCents, 1000);
    assert.equal(pricing.paymentDiscountCents, 900);
    assert.equal(pricing.totalCents, 8100);
    assert.deepEqual(pricing.discountLines.map((line) => line.label), [
        "Code promo MERCI",
        "Réduction retrait espèces (-10%)",
    ]);
});

test("promo outcome rejects unknown, inactive, exhausted, and too-small orders", () => {
    const helpers = createHelpers({
        promoCodes: {
            INACTIVE: { code: "INACTIVE", active: false },
            USED: { code: "USED", active: true, max_redemptions: 2, times_redeemed: 2 },
            MINIMUM: {
                code: "MINIMUM",
                active: true,
                minimum_order_cents: 20000,
                discount_type: "fixed",
                discount_cents: 1000,
            },
        },
    });

    assert.match(helpers.getPromoCodeOutcome("missing", 10000).error, /n'existe pas/);
    assert.match(helpers.getPromoCodeOutcome("inactive", 10000).error, /désactivé/);
    assert.match(helpers.getPromoCodeOutcome("used", 10000).error, /limite/);
    assert.match(helpers.getPromoCodeOutcome("minimum", 10000).error, /au moins/);
});

test("checkout validation enforces delivery/payment constraints and billing copy", () => {
    const helpers = createHelpers();

    assert.throws(() => helpers.validateCheckoutInput({
        customer_email: "client@example.test",
        customer_first_name: "Ada",
        customer_last_name: "Lovelace",
        delivery_method: "ship",
        shipping_address1: "Rue 1",
        shipping_postal_code: "2000",
        shipping_city: "Neuchâtel",
        billing_same_as_shipping: "1",
        payment_method: "cash",
    }), /espèces/);

    const checkout = helpers.validateCheckoutInput({
        customer_email: "client@example.test",
        customer_first_name: "Ada",
        customer_last_name: "Lovelace",
        delivery_method: "ship",
        shipping_address1: "Rue 1",
        shipping_postal_code: "2000",
        shipping_city: "Neuchâtel",
        billing_same_as_shipping: "1",
        payment_method: "transfer",
    });

    assert.equal(checkout.customer.name, "Ada Lovelace");
    assert.equal(checkout.form.billing_address1, "Rue 1");
    assert.equal(checkout.shippingOption.key, "ship");
});
